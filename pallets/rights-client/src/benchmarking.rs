//! FRAME benchmarks for `pallet-rights-client` (Finding L).

use super::*;
use frame::deps::frame_benchmarking::v2::*;
use frame::prelude::*;
use frame::traits::fungible::{Inspect, Mutate};
use frame_system::RawOrigin;
use polkadot_sdk::staging_xcm::latest::prelude::*;

fn escrow<T: Config>() -> BalanceOf<T> {
	T::EscrowCurrency::minimum_balance().saturating_mul(1_000u32.into())
}

fn funded_caller<T: Config>() -> T::AccountId {
	let who: T::AccountId = whitelisted_caller();
	let amount = BalanceOf::<T>::max_value() / 100_000u32.into();
	let _ = T::EscrowCurrency::set_balance(&who, amount);
	who
}

#[benchmarks]
mod benchmarks {
	use super::*;

	/// Escrow transfer, query registration and sending the eight-instruction
	/// program (the largest request: purchase_views carries two u32 arguments).
	#[benchmark]
	fn request() {
		let who = funded_caller::<T>();
		T::BenchmarkHelper::prepare_delivery();
		#[extrinsic_call]
		_(
			RawOrigin::Signed(who),
			RightsRequest::PurchaseViews { content_id: 1, num_views: 10 },
			escrow::<T>(),
		);
		assert_eq!(Pending::<T>::iter().count(), 1);
	}

	/// Settling a failure report (escrow refunded to the user).
	#[benchmark]
	fn on_outcome() {
		let who = funded_caller::<T>();
		T::BenchmarkHelper::prepare_delivery();
		Pallet::<T>::request(
			RawOrigin::Signed(who).into(),
			RightsRequest::Subscribe { content_id: 1 },
			escrow::<T>(),
		)
		.expect("request");
		let query_id = Pending::<T>::iter_keys().next().expect("pending");
		let origin = T::BenchmarkHelper::response_origin(T::RightsChain::get());
		#[extrinsic_call]
		_(
			origin as <T as frame_system::Config>::RuntimeOrigin,
			query_id,
			Response::DispatchResult(MaybeErrorCode::Error(Default::default())),
		);
		assert!(Pending::<T>::get(query_id).is_none());
	}

	impl_benchmark_test_suite!(Pallet, crate::mock::new_test_ext(), crate::mock::Test);
}
