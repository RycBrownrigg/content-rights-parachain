use frame::prelude::*;

// TODO: Run benchmarks for production weights
pub trait WeightInfo {
	fn register_content() -> Weight;
	fn subscribe() -> Weight;
	fn renew_subscription() -> Weight;
	fn purchase_views() -> Weight;
	fn consume_view() -> Weight;
	fn purchase_ownership() -> Weight;
	fn check_access() -> Weight;
	fn xcm_subscribe() -> Weight;
	fn xcm_renew_subscription() -> Weight;
	fn xcm_purchase_views() -> Weight;
	fn xcm_purchase_ownership() -> Weight;
	fn transfer_ownership() -> Weight;
	fn xcm_transfer_ownership() -> Weight;
}

pub struct SubstrateWeight<T>(core::marker::PhantomData<T>);

impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn register_content() -> Weight {
		// TODO: Run benchmarks
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(1))
			.saturating_add(T::DbWeight::get().writes(3))
	}

	fn subscribe() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(3))
	}

	fn renew_subscription() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(1))
	}

	fn purchase_views() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(3))
	}

	fn consume_view() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(1))
	}

	fn purchase_ownership() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(3))
	}

	fn check_access() -> Weight {
		Weight::from_parts(20_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(3))
	}

	// Cross-chain extrinsics — same weights as local equivalents.
	// TODO: Run benchmarks for production weights.

	fn xcm_subscribe() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(3))
	}

	fn xcm_renew_subscription() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(1))
	}

	fn xcm_purchase_views() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(3))
	}

	fn xcm_purchase_ownership() -> Weight {
		Weight::from_parts(50_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2))
			.saturating_add(T::DbWeight::get().writes(3))
	}

	fn transfer_ownership() -> Weight {
		// burn old NFT + mint new NFT + update ownership + nesting cleanup
		Weight::from_parts(80_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(3))
			.saturating_add(T::DbWeight::get().writes(5))
	}

	fn xcm_transfer_ownership() -> Weight {
		Weight::from_parts(80_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(3))
			.saturating_add(T::DbWeight::get().writes(5))
	}
}
