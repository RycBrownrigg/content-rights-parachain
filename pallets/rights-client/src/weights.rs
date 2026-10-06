use frame::prelude::*;

pub trait WeightInfo {
	fn request() -> Weight;
	fn on_outcome() -> Weight;
}

/// Hand-set weights (to be replaced by FRAME benchmarks, Finding L).
pub struct SubstrateWeight<T>(core::marker::PhantomData<T>);

impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn request() -> Weight {
		// escrow transfer, pallet-xcm query registration and send, Pending insert
		Weight::from_parts(100_000_000, 10_000)
			.saturating_add(T::DbWeight::get().reads(6))
			.saturating_add(T::DbWeight::get().writes(6))
	}

	fn on_outcome() -> Weight {
		// Pending take and one transfer
		Weight::from_parts(40_000_000, 8_000)
			.saturating_add(T::DbWeight::get().reads(3))
			.saturating_add(T::DbWeight::get().writes(3))
	}
}
