//! Custom precompile for content rights management.
//!
//! This precompile exposes read-only access to `pallet-content-rights` storage,
//! allowing ink! contracts (and Solidity/Ethereum clients) to verify content
//! access rights by reading pallet state through a standard EVM precompile interface.
//!
//! Write operations (subscribe, purchase, etc.) remain as pallet extrinsics,
//! since they involve payment transfers and NFT minting that require full
//! transaction context.

use alloc::vec::Vec;
use core::marker::PhantomData;
use core::num::NonZero;

use polkadot_sdk::{frame_support, frame_system, pallet_revive, sp_core};

use pallet_revive::precompiles::{AddressMatcher, Error, Ext, Precompile, Token};
use pallet_revive::precompiles::alloy;
use pallet_revive::Config;
use alloy_sol_types::{SolType, SolValue};
use sp_core::H160;
use frame_support::weights::Weight;

// Define the Solidity interface for the content rights precompile.
// Contracts and Ethereum clients call these functions using standard EVM ABI encoding.
alloy::sol! {
	interface IContentRights {
		/// Check whether `who` has access to content. Returns a RightsType enum value:
		/// 0 = Subscription, 1 = PayPerView, 2 = Ownership, 3 = None
		function checkAccess(uint32 contentId, address who) external view returns (uint8 rightsType);

		/// Get content metadata by ID.
		function getContent(uint32 contentId) external view returns (
			address creator,
			bytes32 metadataHash,
			uint128 subscriptionPrice,
			uint128 ppvPrice,
			uint128 ownershipPrice,
			uint32 periodLength
		);

		/// Check if a user owns content permanently.
		function isOwner(uint32 contentId, address who) external view returns (bool owned);

		/// Get subscription state for a user and content.
		function getSubscription(uint32 contentId, address subscriber) external view returns (
			bool exists,
			uint32 expiryBlock
		);

		/// Get view pack state for a user and content.
		function getViewPack(uint32 contentId, address viewer) external view returns (
			bool exists,
			uint32 viewsRemaining
		);
	}
}

/// Weight token for storage reads in the precompile.
/// TODO: Replace with benchmarked weights.
#[derive(Copy, Clone, Debug)]
struct StorageRead(u32);

impl<T: Config> Token<T> for StorageRead {
	fn weight(&self) -> Weight {
		// Placeholder: ~25_000 ref_time per storage read, no proof size
		Weight::from_parts(25_000 * self.0 as u64, 0)
	}
}

/// Precompile that provides read-only access to `pallet-content-rights` storage.
///
/// Address: `0x00000000000000000000000000000000_10010000`
/// (AddressMatcher::Fixed with u16 = 0x1001, placed at bytes [16..18])
pub struct ContentRightsPrecompile<T>(PhantomData<T>);

impl<T> Precompile for ContentRightsPrecompile<T>
where
	T: pallet_revive::Config + pallet_content_rights::Config,
{
	type T = T;
	type Interface = IContentRights::IContentRightsCalls;
	const MATCHER: AddressMatcher =
		AddressMatcher::Fixed(NonZero::new(0x1001).expect("0x1001 is non-zero"));
	const HAS_CONTRACT_INFO: bool = false;

	fn call(
		_address: &[u8; 20],
		input: &Self::Interface,
		env: &mut impl Ext<T = Self::T>,
	) -> Result<Vec<u8>, Error> {
		use IContentRights::IContentRightsCalls::*;

		match input {
			checkAccess(call) => {
				env.frame_meter_mut().charge_weight_token(StorageRead(3))?;

				let who = env.to_account_id(&H160(call.who.0 .0));
				let content_id = call.contentId;

				// Verify content exists
				if pallet_content_rights::Contents::<T>::get(content_id).is_none() {
					return Err(Error::Revert("ContentNotFound".into()));
				}

				// Ownership = 2 (highest priority, cheapest check)
				if pallet_content_rights::Ownership::<T>::get(content_id, &who) {
					return Ok(alloy_sol_types::sol_data::Uint::<8>::abi_encode(&2));
				}

				// Active subscription = 0
				if let Some(sub) =
					pallet_content_rights::Subscriptions::<T>::get(content_id, &who)
				{
					let current_block: u32 =
						frame_system::Pallet::<T>::block_number()
							.try_into()
							.unwrap_or(0u32);
					if current_block < sub.expiry_block {
						return Ok(alloy_sol_types::sol_data::Uint::<8>::abi_encode(&0));
					}
				}

				// PayPerView = 1
				if let Some(pack) =
					pallet_content_rights::ViewPacks::<T>::get(content_id, &who)
				{
					if pack.views_remaining > 0 {
						return Ok(alloy_sol_types::sol_data::Uint::<8>::abi_encode(&1));
					}
				}

				// None = 3
				Ok(alloy_sol_types::sol_data::Uint::<8>::abi_encode(&3))
			}

			getContent(call) => {
				env.frame_meter_mut().charge_weight_token(StorageRead(1))?;

				let content = pallet_content_rights::Contents::<T>::get(call.contentId)
					.ok_or(Error::Revert("ContentNotFound".into()))?;

				// Convert creator AccountId to H160 via the runtime's AddressMapper
				let creator_h160 =
					<<T as pallet_revive::Config>::AddressMapper as pallet_revive::AddressMapper<T>>::to_address(&content.creator);

				let result = (
					alloy::primitives::Address::from(creator_h160.0),
					alloy::primitives::FixedBytes::<32>(content.metadata_hash),
					content.subscription_price,
					content.ppv_price,
					content.ownership_price,
					content.period_length,
				);
				Ok(SolValue::abi_encode(&result))
			}

			isOwner(call) => {
				env.frame_meter_mut().charge_weight_token(StorageRead(1))?;

				let who = env.to_account_id(&H160(call.who.0 .0));
				let owned =
					pallet_content_rights::Ownership::<T>::get(call.contentId, &who);
				Ok(SolValue::abi_encode(&owned))
			}

			getSubscription(call) => {
				env.frame_meter_mut().charge_weight_token(StorageRead(1))?;

				let who = env.to_account_id(&H160(call.subscriber.0 .0));
				match pallet_content_rights::Subscriptions::<T>::get(
					call.contentId,
					&who,
				) {
					Some(sub) => Ok(SolValue::abi_encode(&(true, sub.expiry_block))),
					None => Ok(SolValue::abi_encode(&(false, 0u32))),
				}
			}

			getViewPack(call) => {
				env.frame_meter_mut().charge_weight_token(StorageRead(1))?;

				let who = env.to_account_id(&H160(call.viewer.0 .0));
				match pallet_content_rights::ViewPacks::<T>::get(
					call.contentId,
					&who,
				) {
					Some(pack) => {
						Ok(SolValue::abi_encode(&(true, pack.views_remaining)))
					}
					None => Ok(SolValue::abi_encode(&(false, 0u32))),
				}
			}
		}
	}
}
