//! Weights for `pallet_rights_verifier`.
//!
//! PLACEHOLDER: hand-set values kept until FRAME benchmarking regenerates this
//! file (Finding L). `b` is the total size in bytes of the two proofs.

#![cfg_attr(rustfmt, rustfmt_skip)]
#![allow(unused_parens)]
#![allow(unused_imports)]
#![allow(missing_docs)]

use frame::weights_prelude::*;

/// Weight functions needed for `pallet_rights_verifier`.
pub trait WeightInfo {
	fn verify_ownership(b: u32, ) -> Weight;
	fn verify_subscription(b: u32, ) -> Weight;
	fn verify_view_pack(b: u32, ) -> Weight;
	fn record_relay_root() -> Weight;
}

/// Placeholder weights (hand-set).
pub struct SubstrateWeight<T>(PhantomData<T>);
impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn verify_ownership(b: u32, ) -> Weight {
		Weight::from_parts(200_000_000, 0)
			.saturating_add(Weight::from_parts(5_000, 0).saturating_mul(b.into()))
			.saturating_add(T::DbWeight::get().reads(1_u64))
	}
	fn verify_subscription(b: u32, ) -> Weight {
		Weight::from_parts(200_000_000, 0)
			.saturating_add(Weight::from_parts(5_000, 0).saturating_mul(b.into()))
			.saturating_add(T::DbWeight::get().reads(1_u64))
	}
	fn verify_view_pack(b: u32, ) -> Weight {
		Weight::from_parts(200_000_000, 0)
			.saturating_add(Weight::from_parts(5_000, 0).saturating_mul(b.into()))
			.saturating_add(T::DbWeight::get().reads(1_u64))
	}
	fn record_relay_root() -> Weight {
		Weight::from_parts(10_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(2_u64))
			.saturating_add(T::DbWeight::get().writes(1_u64))
	}
}

// For backwards compatibility and tests.
impl WeightInfo for () {
	fn verify_ownership(b: u32, ) -> Weight {
		Weight::from_parts(200_000_000, 0)
			.saturating_add(Weight::from_parts(5_000, 0).saturating_mul(b.into()))
			.saturating_add(RocksDbWeight::get().reads(1_u64))
	}
	fn verify_subscription(b: u32, ) -> Weight {
		Weight::from_parts(200_000_000, 0)
			.saturating_add(Weight::from_parts(5_000, 0).saturating_mul(b.into()))
			.saturating_add(RocksDbWeight::get().reads(1_u64))
	}
	fn verify_view_pack(b: u32, ) -> Weight {
		Weight::from_parts(200_000_000, 0)
			.saturating_add(Weight::from_parts(5_000, 0).saturating_mul(b.into()))
			.saturating_add(RocksDbWeight::get().reads(1_u64))
	}
	fn record_relay_root() -> Weight {
		Weight::from_parts(10_000_000, 0)
			.saturating_add(RocksDbWeight::get().reads(2_u64))
			.saturating_add(RocksDbWeight::get().writes(1_u64))
	}
}
