//! Sending-side client for the CCRMS rights chain.
//!
//! A user on this chain asks for a right on CCRMS (subscription, renewal, view
//! pack or ownership) and pays an escrow locally. The pallet sends one XCM
//! program to CCRMS from this chain's sovereign account:
//!
//! ```text
//! WithdrawAsset(fee)
//! BuyExecution { fee, Unlimited }
//! SetAppendix [ RefundSurplus, DepositAsset { All, beneficiary: this chain } ]
//! Transact { SovereignAccount, xcm_* call with the user as beneficiary }
//! ReportTransactStatus { destination: this chain, query_id }
//! ```
//!
//! The appendix runs whether or not execution fails, so unused fees return to
//! this chain's sovereign account on CCRMS instead of the asset trap. CCRMS
//! reports the result of the dispatched call back to this chain, where pallet-xcm
//! matches it to the registered query and calls [`Pallet::on_outcome`]. On success
//! the escrow goes to the operator that funds the sovereign account; on failure
//! it is refunded to the user, which is the compensation step that replaces a
//! cross-chain rollback.
//!
//! Trust assumptions: the operator funds the sovereign account on CCRMS and
//! accepts the escrow the user offers; this pallet does not know CCRMS prices.
//! An execution-fee failure at `BuyExecution` happens before any report is
//! possible, so the request stays pending.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

pub mod weights;

#[cfg(test)]
mod mock;
#[cfg(test)]
mod tests;
#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

/// Runtime hooks needed only by the benchmarks.
#[cfg(feature = "runtime-benchmarks")]
pub trait BenchmarkHelper<Origin> {
	/// Make sending to the rights chain succeed (e.g. open an HRMP channel).
	fn prepare_delivery();
	/// A pallet-xcm response origin from `responder`.
	fn response_origin(responder: polkadot_sdk::staging_xcm::latest::Location) -> Origin;
}

#[frame::pallet]
pub mod pallet {
	use alloc::vec;
	use codec::Encode;
	use frame::prelude::*;
	use frame::traits::{
		fungible::{Inspect, Mutate},
		tokens::Preservation,
	};
	use polkadot_sdk::pallet_xcm;
	use polkadot_sdk::staging_xcm::latest::prelude::*;
	use frame::deps::sp_runtime::traits::AccountIdConversion;

	use crate::weights::WeightInfo;

	pub type BalanceOf<T> =
		<<T as Config>::EscrowCurrency as Inspect<<T as frame_system::Config>::AccountId>>::Balance;

	/// The right a user asks for. Mirrors the CCRMS `xcm_*` extrinsics.
	#[derive(
		Encode,
		Decode,
		codec::DecodeWithMemTracking,
		MaxEncodedLen,
		TypeInfo,
		Clone,
		PartialEq,
		Eq,
		Debug,
	)]
	pub enum RightsRequest {
		Subscribe { content_id: u32 },
		RenewSubscription { content_id: u32 },
		PurchaseViews { content_id: u32, num_views: u32 },
		PurchaseOwnership { content_id: u32 },
	}

	/// A request whose outcome has not yet been reported.
	#[derive(Encode, Decode, MaxEncodedLen, TypeInfo, Clone, PartialEq, Eq, Debug)]
	#[scale_info(skip_type_params(T))]
	pub struct PendingRequest<T: Config> {
		pub who: T::AccountId,
		pub escrow: BalanceOf<T>,
		pub request: RightsRequest,
		pub sent_at: BlockNumberFor<T>,
	}

	#[pallet::config]
	pub trait Config: frame_system::Config + pallet_xcm::Config {
		/// The runtime call type; must be able to carry this pallet's
		/// `on_outcome` call as the pallet-xcm notification.
		type NotifyCall: From<Call<Self>> + Into<<Self as pallet_xcm::Config>::RuntimeCall>;
		/// Origin of pallet-xcm query responses; yields the responder's location
		/// (in a runtime, `pallet_xcm::EnsureResponse<Everything>`).
		type ResponseOrigin: EnsureOrigin<
			<Self as frame_system::Config>::RuntimeOrigin,
			Success = Location,
		>;
		/// Currency in which users pay the escrow.
		type EscrowCurrency: Mutate<Self::AccountId>;
		/// Location of the CCRMS chain, relative to this chain.
		type RightsChain: Get<Location>;
		/// Pallet index of `pallet-content-rights` in the CCRMS runtime.
		#[pallet::constant]
		type RightsPalletIndex: Get<u8>;
		/// This chain's location as seen from CCRMS (refund and report destination).
		type SelfLocation: Get<Location>;
		/// Asset withdrawn on CCRMS from this chain's sovereign account to pay
		/// for execution.
		type ExecutionFee: Get<Asset>;
		/// Blocks after which a query may be treated as timed out by pallet-xcm.
		#[pallet::constant]
		type QueryTimeout: Get<BlockNumberFor<Self>>;
		/// Account that funds the sovereign account on CCRMS and receives the
		/// escrow of successful requests.
		type Operator: Get<Self::AccountId>;
		/// Holds escrows while requests are pending.
		#[pallet::constant]
		type PalletId: Get<frame::deps::frame_support::PalletId>;
		/// Weight information for extrinsics.
		type ClientWeightInfo: crate::weights::WeightInfo;
		/// Benchmark hooks.
		#[cfg(feature = "runtime-benchmarks")]
		type BenchmarkHelper: crate::BenchmarkHelper<OriginFor<Self>>;
	}

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	/// Query ID -> request awaiting its outcome report from CCRMS.
	#[pallet::storage]
	pub type Pending<T: Config> = StorageMap<_, Blake2_128Concat, QueryId, PendingRequest<T>>;

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		/// A rights request was sent to CCRMS.
		/// A rights request was sent to CCRMS. `message_id` is the XCM topic, which
		/// CCRMS reports in `messageQueue.Processed`.
		RequestSent {
			query_id: QueryId,
			who: T::AccountId,
			request: RightsRequest,
			escrow: BalanceOf<T>,
			message_id: XcmHash,
		},
		/// CCRMS reported the outcome; on failure the escrow was refunded.
		OutcomeReported { query_id: QueryId, who: T::AccountId, success: bool },
	}

	#[pallet::error]
	pub enum Error<T> {
		/// The XCM message could not be sent.
		SendFailed,
		/// No pending request has this query ID.
		UnknownQuery,
		/// The report did not come from the CCRMS chain.
		WrongResponder,
		/// The account ID cannot be used as a CCRMS beneficiary (not 32 bytes).
		BadBeneficiary,
	}

	impl<T: Config> Pallet<T> {
		/// Account that holds escrows.
		pub fn escrow_account() -> T::AccountId {
			T::PalletId::get().into_account_truncating()
		}

		/// SCALE-encoded CCRMS call for `request`, with `beneficiary` as the
		/// rights holder. Call indices are those of `pallet-content-rights`.
		pub fn remote_call(request: &RightsRequest, beneficiary: [u8; 32]) -> alloc::vec::Vec<u8> {
			let p = T::RightsPalletIndex::get();
			match request {
				RightsRequest::Subscribe { content_id } => (p, 7u8, content_id, beneficiary).encode(),
				RightsRequest::RenewSubscription { content_id } =>
					(p, 8u8, content_id, beneficiary).encode(),
				RightsRequest::PurchaseViews { content_id, num_views } =>
					(p, 9u8, content_id, beneficiary, num_views).encode(),
				RightsRequest::PurchaseOwnership { content_id } =>
					(p, 10u8, content_id, beneficiary).encode(),
			}
		}

		/// The complete XCM program sent to CCRMS.
		pub fn rights_message(call: alloc::vec::Vec<u8>, query_id: QueryId) -> Xcm<()> {
			let fee = T::ExecutionFee::get();
			Xcm(vec![
				WithdrawAsset(fee.clone().into()),
				BuyExecution { fees: fee, weight_limit: Unlimited },
				SetAppendix(Xcm(vec![
					RefundSurplus,
					DepositAsset {
						assets: Wild(AllCounted(1)),
						beneficiary: T::SelfLocation::get(),
					},
				])),
				Transact {
					origin_kind: OriginKind::SovereignAccount,
					fallback_max_weight: None,
					call: call.into(),
				},
				ReportTransactStatus(QueryResponseInfo {
					destination: T::SelfLocation::get(),
					query_id,
					max_weight: T::ClientWeightInfo::on_outcome(),
				}),
			])
		}
	}

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Ask CCRMS for a right, held by the caller's own account key on CCRMS,
		/// paying `escrow` here. The escrow is refunded if CCRMS reports failure.
		#[pallet::call_index(0)]
		#[pallet::weight(T::ClientWeightInfo::request())]
		pub fn request(
			origin: OriginFor<T>,
			request: RightsRequest,
			escrow: BalanceOf<T>,
		) -> DispatchResult {
			let who = ensure_signed(origin)?;
			let beneficiary: [u8; 32] =
				who.encode().try_into().map_err(|_| Error::<T>::BadBeneficiary)?;

			T::EscrowCurrency::transfer(&who, &Self::escrow_account(), escrow, Preservation::Preserve)?;

			let now = frame_system::Pallet::<T>::block_number();
			let notify = Call::<T>::on_outcome { query_id: 0, response: Response::Null };
			let query_id = pallet_xcm::Pallet::<T>::new_notify_query(
				T::RightsChain::get(),
				<T as Config>::NotifyCall::from(notify).into(),
				now.saturating_add(T::QueryTimeout::get()),
				Here,
			);

			let message = Self::rights_message(Self::remote_call(&request, beneficiary), query_id);
			let message_id = pallet_xcm::Pallet::<T>::send_xcm(Here, T::RightsChain::get(), message)
				.map_err(|_| Error::<T>::SendFailed)?;

			Pending::<T>::insert(
				query_id,
				PendingRequest { who: who.clone(), escrow, request: request.clone(), sent_at: now },
			);
			Self::deposit_event(Event::RequestSent { query_id, who, request, escrow, message_id });
			Ok(())
		}

		/// Called by pallet-xcm when CCRMS reports the outcome of a request.
		/// Releases the escrow to the operator on success, refunds it otherwise.
		#[pallet::call_index(1)]
		#[pallet::weight(T::ClientWeightInfo::on_outcome())]
		pub fn on_outcome(
			origin: OriginFor<T>,
			query_id: QueryId,
			response: Response,
		) -> DispatchResult {
			let responder = T::ResponseOrigin::ensure_origin(origin)?;
			ensure!(responder == T::RightsChain::get(), Error::<T>::WrongResponder);
			let pending = Pending::<T>::take(query_id).ok_or(Error::<T>::UnknownQuery)?;

			let success = matches!(response, Response::DispatchResult(MaybeErrorCode::Success));
			let to = if success { T::Operator::get() } else { pending.who.clone() };
			T::EscrowCurrency::transfer(
				&Self::escrow_account(),
				&to,
				pending.escrow,
				Preservation::Expendable,
			)?;

			Self::deposit_event(Event::OutcomeReported { query_id, who: pending.who, success });
			Ok(())
		}
	}
}
