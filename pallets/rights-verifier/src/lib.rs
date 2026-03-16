//! Cross-chain content rights verification via Merkle storage proofs.
//!
//! Allows a parachain to cryptographically verify content rights state
//! (ownership, subscriptions, view packs) stored on a remote parachain,
//! without trusting the remote chain's response.
//!
//! # Functions
//!
//! - `verify_ownership` — Verifies permanent ownership via storage proof.
//! - `verify_subscription` — Verifies subscription status via storage proof.
//! - `verify_view_pack` — Verifies pay-per-view balance via storage proof.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;
use alloc::vec::Vec;

pub use pallet::*;

#[cfg(test)]
mod mock;

#[cfg(test)]
mod tests;

/// Types shared with the remote content-rights pallet for decoding storage values.
pub mod remote_types {
	use codec::{Decode, Encode};
	use scale_info::TypeInfo;

	/// Mirrors `pallet_content_rights::types::OwnershipInfo`.
	#[derive(Encode, Decode, TypeInfo, Clone, Debug)]
	pub struct OwnershipInfo {
		pub child_item_id: u32,
	}

	/// Mirrors `pallet_content_rights::types::SubscriptionInfo`.
	#[derive(Encode, Decode, TypeInfo, Clone, Debug)]
	pub struct SubscriptionInfo {
		pub expiry_block: u32,
		pub auto_renew: bool,
		pub child_item_id: u32,
	}

	/// Mirrors `pallet_content_rights::types::ViewPackInfo`.
	#[derive(Encode, Decode, TypeInfo, Clone, Debug)]
	pub struct ViewPackInfo {
		pub views_remaining: u32,
		pub child_item_id: u32,
	}
}

#[frame::pallet]
pub mod pallet {
	use alloc::vec::Vec;
	use codec::{Decode, Encode};
	use frame::prelude::*;
	use polkadot_sdk::sp_core::H256;
	use polkadot_sdk::sp_runtime::traits::BlakeTwo256;
	use polkadot_sdk::sp_trie::{LayoutV1, StorageProof};

	use crate::{remote_types, WeightInfo};

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// Weight information for extrinsics.
		type VerifierWeightInfo: crate::WeightInfo;
	}

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	// --------------- Events ---------------

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		OwnershipVerified {
			content_id: u32,
			who: T::AccountId,
			is_owner: bool,
			state_root: H256,
		},
		SubscriptionVerified {
			content_id: u32,
			who: T::AccountId,
			is_active: bool,
			expiry_block: u32,
			state_root: H256,
		},
		ViewPackVerified {
			content_id: u32,
			who: T::AccountId,
			has_views: bool,
			views_remaining: u32,
			state_root: H256,
		},
	}

	// --------------- Errors ---------------

	#[pallet::error]
	pub enum Error<T> {
		/// The provided Merkle proof is invalid or does not match the state root.
		InvalidProof,
		/// The storage value could not be decoded into the expected type.
		DecodingFailed,
	}

	// --------------- Helpers ---------------

	impl<T: Config> Pallet<T> {
		/// Construct the full storage key for a content-rights `StorageDoubleMap` entry
		/// on the remote chain.
		///
		/// Key format: `Twox128(pallet) ++ Twox128(storage) ++ Blake2_128Concat(key1) ++ Blake2_128Concat(key2)`
		fn content_rights_key(
			storage_name: &[u8],
			content_id: u32,
			who: &T::AccountId,
		) -> Vec<u8> {
			use frame::deps::frame_support::StorageHasher;

			let pallet_hash = polkadot_sdk::sp_core::hashing::twox_128(b"ContentRights");
			let storage_hash = polkadot_sdk::sp_core::hashing::twox_128(storage_name);

			let key1_hashed =
				frame::deps::frame_support::Blake2_128Concat::hash(&content_id.encode());
			let key2_hashed =
				frame::deps::frame_support::Blake2_128Concat::hash(&who.encode());

			let mut key = Vec::with_capacity(
				pallet_hash.len()
					+ storage_hash.len()
					+ key1_hashed.len()
					+ key2_hashed.len(),
			);
			key.extend_from_slice(&pallet_hash);
			key.extend_from_slice(&storage_hash);
			key.extend_from_slice(&key1_hashed);
			key.extend_from_slice(&key2_hashed);
			key
		}

		/// Read and optionally decode a value from a Merkle storage proof.
		fn read_proof_value(
			state_root: &H256,
			proof_nodes: Vec<Vec<u8>>,
			key: &[u8],
		) -> Result<Option<Vec<u8>>, Error<T>> {
			let db: polkadot_sdk::sp_trie::MemoryDB<BlakeTwo256> =
				StorageProof::new(proof_nodes).into_memory_db();

			polkadot_sdk::sp_trie::read_trie_value::<LayoutV1<BlakeTwo256>, _>(
				&db,
				state_root,
				key,
				None,
				None,
			)
			.map_err(|_| Error::<T>::InvalidProof)
		}
	}

	// --------------- Extrinsics ---------------

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Verify that a user owns content on the remote content-rights chain.
		///
		/// The caller supplies the remote chain's state root and a Merkle proof
		/// for the `Ownership(content_id, who)` storage entry. The pallet verifies
		/// the proof and emits `OwnershipVerified` with the result.
		#[pallet::call_index(0)]
		#[pallet::weight(<T as Config>::VerifierWeightInfo::verify_ownership())]
		pub fn verify_ownership(
			origin: OriginFor<T>,
			state_root: H256,
			proof: Vec<Vec<u8>>,
			content_id: u32,
			who: T::AccountId,
		) -> DispatchResult {
			ensure_signed(origin)?;

			let key = Self::content_rights_key(b"Ownership", content_id, &who);
			let raw_value = Self::read_proof_value(&state_root, proof, &key)?;

			let is_owner = match raw_value {
				Some(bytes) => {
					// Decode to verify it's a valid OwnershipInfo
					remote_types::OwnershipInfo::decode(&mut &bytes[..])
						.map_err(|_| Error::<T>::DecodingFailed)?;
					true
				}
				None => false,
			};

			Self::deposit_event(Event::OwnershipVerified {
				content_id,
				who,
				is_owner,
				state_root,
			});

			Ok(())
		}

		/// Verify a user's subscription status on the remote content-rights chain.
		#[pallet::call_index(1)]
		#[pallet::weight(<T as Config>::VerifierWeightInfo::verify_subscription())]
		pub fn verify_subscription(
			origin: OriginFor<T>,
			state_root: H256,
			proof: Vec<Vec<u8>>,
			content_id: u32,
			who: T::AccountId,
		) -> DispatchResult {
			ensure_signed(origin)?;

			let key = Self::content_rights_key(b"Subscriptions", content_id, &who);
			let raw_value = Self::read_proof_value(&state_root, proof, &key)?;

			let (is_active, expiry_block) = match raw_value {
				Some(bytes) => {
					let info = remote_types::SubscriptionInfo::decode(&mut &bytes[..])
						.map_err(|_| Error::<T>::DecodingFailed)?;
					// We report the expiry block; the caller decides if it's active
					// based on their knowledge of the remote chain's block height.
					(true, info.expiry_block)
				}
				None => (false, 0),
			};

			Self::deposit_event(Event::SubscriptionVerified {
				content_id,
				who,
				is_active,
				expiry_block,
				state_root,
			});

			Ok(())
		}

		/// Verify a user's pay-per-view balance on the remote content-rights chain.
		#[pallet::call_index(2)]
		#[pallet::weight(<T as Config>::VerifierWeightInfo::verify_view_pack())]
		pub fn verify_view_pack(
			origin: OriginFor<T>,
			state_root: H256,
			proof: Vec<Vec<u8>>,
			content_id: u32,
			who: T::AccountId,
		) -> DispatchResult {
			ensure_signed(origin)?;

			let key = Self::content_rights_key(b"ViewPacks", content_id, &who);
			let raw_value = Self::read_proof_value(&state_root, proof, &key)?;

			let (has_views, views_remaining) = match raw_value {
				Some(bytes) => {
					let info = remote_types::ViewPackInfo::decode(&mut &bytes[..])
						.map_err(|_| Error::<T>::DecodingFailed)?;
					(info.views_remaining > 0, info.views_remaining)
				}
				None => (false, 0),
			};

			Self::deposit_event(Event::ViewPackVerified {
				content_id,
				who,
				has_views,
				views_remaining,
				state_root,
			});

			Ok(())
		}
	}
}

// --------------- Weights ---------------

use frame::prelude::*;

/// Weight information for the rights-verifier pallet.
pub trait WeightInfo {
	fn verify_ownership() -> Weight;
	fn verify_subscription() -> Weight;
	fn verify_view_pack() -> Weight;
}

/// Placeholder weights. TODO: Replace with benchmarked values.
pub struct SubstrateWeight<T>(core::marker::PhantomData<T>);

impl<T: frame_system::Config> WeightInfo for SubstrateWeight<T> {
	fn verify_ownership() -> Weight {
		// Proof verification is CPU-intensive (trie hashing)
		Weight::from_parts(100_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(1))
	}

	fn verify_subscription() -> Weight {
		Weight::from_parts(100_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(1))
	}

	fn verify_view_pack() -> Weight {
		Weight::from_parts(100_000_000, 0)
			.saturating_add(T::DbWeight::get().reads(1))
	}
}
