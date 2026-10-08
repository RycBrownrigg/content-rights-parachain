//! Cross-chain content rights verification via Merkle storage proofs.
//!
//! Lets a parachain check content rights state (ownership, subscriptions, view
//! packs) held on the CCRMS parachain without trusting the caller or a relayer.
//!
//! # Trust root
//!
//! Every block, the pallet records the relay-parent number and relay-chain
//! storage root that the validators supplied to this chain (through
//! `set_validation_data`), keeping the most recent `MaxRelayRoots`. A caller
//! submits two proofs:
//!
//! 1. a relay-chain storage proof of `Paras::Heads(RightsParaId)` against one of
//!    the recorded relay roots, which yields the CCRMS header included in that
//!    relay block, and with it the CCRMS state root and block number;
//! 2. a CCRMS storage proof of the rights entry against that state root.
//!
//! Neither root comes from the caller. The CCRMS state is the state of the CCRMS
//! block included at the chosen relay block; subscription activity is judged
//! against that block's number.
//!
//! # Functions
//!
//! - `verify_ownership` — permanent ownership.
//! - `verify_subscription` — subscription, active if the proven CCRMS block is
//!   before its expiry.
//! - `verify_view_pack` — pay-per-view balance.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;

#[cfg(test)]
mod tests;

#[cfg(feature = "runtime-benchmarks")]
mod benchmarking;

pub mod weights;
pub use weights::*;

/// Source of the trusted relay-parent state for the current block. In a
/// parachain runtime, adapt `cumulus_pallet_parachain_system::RelaychainDataProvider`.
pub trait RelayStateSource {
	/// Relay-parent number and relay-chain storage root of the current block,
	/// or `None` if not available (for example before `set_validation_data`).
	fn current() -> Option<(u32, polkadot_sdk::sp_core::H256)>;

	/// Make `current` return this relay parent (benchmarks only).
	#[cfg(feature = "runtime-benchmarks")]
	fn set_for_benchmarks(_number: u32, _root: polkadot_sdk::sp_core::H256) {}
}

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

	use crate::{remote_types, RelayStateSource, WeightInfo};

	/// Maximum total size in bytes of the two proofs in one call. Real proofs are
	/// a few KiB; the cap bounds the hashing work a caller can demand, and the
	/// weight is charged per byte below it.
	pub const MAX_PROOF_BYTES: u32 = 16_384;

	/// Header type of the CCRMS chain (32-bit block numbers, BLAKE2-256).
	pub type RightsHeader = polkadot_sdk::sp_runtime::generic::Header<u32, BlakeTwo256>;

	/// Storage-key prefix of the relay chain's `Paras::Heads` map
	/// (`polkadot_primitives::well_known_keys::para_head`).
	const PARA_HEAD_PREFIX: [u8; 32] = [
		0xcd, 0x71, 0x0b, 0x30, 0xbd, 0x2e, 0xab, 0x03, 0x52, 0xdd, 0xcc, 0x26, 0x41, 0x7a, 0xa1,
		0x94, 0x1b, 0x3c, 0x25, 0x2f, 0xcb, 0x29, 0xd8, 0x8e, 0xff, 0x4f, 0x3d, 0xe5, 0xde, 0x44,
		0x76, 0xc3,
	];

	#[pallet::config]
	pub trait Config: frame_system::Config {
		/// Weight information for extrinsics.
		type VerifierWeightInfo: crate::WeightInfo;
		/// Trusted relay-parent state of the current block.
		type RelayState: RelayStateSource;
		/// Para ID of the CCRMS chain whose head is read from relay state.
		#[pallet::constant]
		type RightsParaId: Get<u32>;
		/// Number of recent relay roots kept for verification.
		#[pallet::constant]
		type MaxRelayRoots: Get<u32>;
	}

	#[pallet::pallet]
	pub struct Pallet<T>(_);

	/// Recent (relay-parent number, relay-chain storage root) pairs, oldest first.
	#[pallet::storage]
	pub type RelayRoots<T: Config> =
		StorageValue<_, BoundedVec<(u32, H256), T::MaxRelayRoots>, ValueQuery>;

	// --------------- Events ---------------

	#[pallet::event]
	#[pallet::generate_deposit(pub(super) fn deposit_event)]
	pub enum Event<T: Config> {
		OwnershipVerified {
			content_id: u32,
			who: T::AccountId,
			is_owner: bool,
			relay_block: u32,
			rights_block: u32,
		},
		SubscriptionVerified {
			content_id: u32,
			who: T::AccountId,
			is_active: bool,
			expiry_block: u32,
			relay_block: u32,
			rights_block: u32,
		},
		ViewPackVerified {
			content_id: u32,
			who: T::AccountId,
			has_views: bool,
			views_remaining: u32,
			relay_block: u32,
			rights_block: u32,
		},
	}

	// --------------- Errors ---------------

	#[pallet::error]
	pub enum Error<T> {
		/// A Merkle proof is invalid or does not match its root.
		InvalidProof,
		/// A storage value or the CCRMS header could not be decoded.
		DecodingFailed,
		/// No recorded relay root for this relay block (too old, or never seen).
		UnknownRelayBlock,
		/// The relay proof shows no head for the CCRMS para at that relay block.
		NoRightsHead,
		/// The two proofs together exceed `MAX_PROOF_BYTES`.
		ProofTooLarge,
	}

	// --------------- Hooks ---------------

	#[pallet::hooks]
	impl<T: Config> Hooks<BlockNumberFor<T>> for Pallet<T> {
		fn on_initialize(_n: BlockNumberFor<T>) -> Weight {
			// Charged here for the recording done in on_finalize.
			<T as Config>::VerifierWeightInfo::record_relay_root()
		}

		/// Record this block's relay parent; runs after `set_validation_data`.
		fn on_finalize(_n: BlockNumberFor<T>) {
			Self::record_relay_root();
		}
	}

	// --------------- Helpers ---------------

	impl<T: Config> Pallet<T> {
		/// Append the current relay parent to `RelayRoots`, dropping the oldest
		/// entry when full. Consecutive blocks can share a relay parent; it is
		/// stored once.
		pub fn record_relay_root() {
			let Some((number, root)) = T::RelayState::current() else { return };
			RelayRoots::<T>::mutate(|roots| {
				if roots.iter().any(|(n, _)| *n == number) {
					return;
				}
				if roots.is_full() {
					roots.remove(0);
				}
				let _ = roots.try_push((number, root));
			});
		}

		/// Total size of the two proofs, saturating (for weight and the size cap).
		pub fn proof_bytes(relay_proof: &[Vec<u8>], rights_proof: &[Vec<u8>]) -> u32 {
			relay_proof
				.iter()
				.chain(rights_proof.iter())
				.fold(0usize, |acc, node| acc.saturating_add(node.len()))
				.try_into()
				.unwrap_or(u32::MAX)
		}

		/// Storage key of `Paras::Heads(para_id)` in relay-chain state.
		pub fn para_head_key(para_id: u32) -> Vec<u8> {
			let id = para_id.encode();
			let mut key = PARA_HEAD_PREFIX.to_vec();
			key.extend_from_slice(&polkadot_sdk::sp_core::hashing::twox_64(&id));
			key.extend_from_slice(&id);
			key
		}

		/// Prove the CCRMS header included at `relay_block`, using the recorded
		/// relay root. Returns the CCRMS state root and block number.
		fn rights_state(
			relay_block: u32,
			relay_proof: Vec<Vec<u8>>,
		) -> Result<(H256, u32), Error<T>> {
			let relay_root = RelayRoots::<T>::get()
				.iter()
				.find(|(n, _)| *n == relay_block)
				.map(|(_, r)| *r)
				.ok_or(Error::<T>::UnknownRelayBlock)?;
			let head = Self::read_proof_value(
				&relay_root,
				relay_proof,
				&Self::para_head_key(T::RightsParaId::get()),
			)?
			.ok_or(Error::<T>::NoRightsHead)?;
			// `Paras::Heads` stores `HeadData(Vec<u8>)`; for a Cumulus chain the
			// bytes are the SCALE-encoded header.
			let head_data =
				Vec::<u8>::decode(&mut &head[..]).map_err(|_| Error::<T>::DecodingFailed)?;
			let header = RightsHeader::decode(&mut &head_data[..])
				.map_err(|_| Error::<T>::DecodingFailed)?;
			Ok((header.state_root, header.number))
		}

		/// Construct the full storage key for a content-rights `StorageDoubleMap`
		/// entry on the CCRMS chain.
		///
		/// Key format: `Twox128(pallet) ++ Twox128(storage) ++ Blake2_128Concat(key1) ++ Blake2_128Concat(key2)`
		pub(crate) fn content_rights_key(
			storage_name: &[u8],
			content_id: u32,
			who: &T::AccountId,
		) -> Vec<u8> {
			use frame::deps::frame_support::StorageHasher;

			let mut key = Vec::new();
			key.extend_from_slice(&polkadot_sdk::sp_core::hashing::twox_128(b"ContentRights"));
			key.extend_from_slice(&polkadot_sdk::sp_core::hashing::twox_128(storage_name));
			key.extend_from_slice(&frame::deps::frame_support::Blake2_128Concat::hash(
				&content_id.encode(),
			));
			key.extend_from_slice(&frame::deps::frame_support::Blake2_128Concat::hash(
				&who.encode(),
			));
			key
		}

		/// Read a value from a Merkle storage proof against `state_root`.
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

		/// Prove the rights entry `storage_name(content_id, who)` on CCRMS via the
		/// relay chain. Returns the raw value (if any), relay block and CCRMS block.
		fn read_rights_entry(
			relay_block: u32,
			relay_proof: Vec<Vec<u8>>,
			rights_proof: Vec<Vec<u8>>,
			storage_name: &[u8],
			content_id: u32,
			who: &T::AccountId,
		) -> Result<(Option<Vec<u8>>, u32), Error<T>> {
			ensure!(
				Self::proof_bytes(&relay_proof, &rights_proof) <= MAX_PROOF_BYTES,
				Error::<T>::ProofTooLarge
			);
			let (state_root, rights_block) = Self::rights_state(relay_block, relay_proof)?;
			let key = Self::content_rights_key(storage_name, content_id, who);
			Ok((Self::read_proof_value(&state_root, rights_proof, &key)?, rights_block))
		}
	}

	// --------------- Extrinsics ---------------

	#[pallet::call]
	impl<T: Config> Pallet<T> {
		/// Verify that `who` owns `content_id` on CCRMS, as of the CCRMS block
		/// included at `relay_block`.
		#[pallet::call_index(0)]
		#[pallet::weight(<T as Config>::VerifierWeightInfo::verify_ownership(Pallet::<T>::proof_bytes(relay_proof, rights_proof)))]
		pub fn verify_ownership(
			origin: OriginFor<T>,
			relay_block: u32,
			relay_proof: Vec<Vec<u8>>,
			rights_proof: Vec<Vec<u8>>,
			content_id: u32,
			who: T::AccountId,
		) -> DispatchResult {
			ensure_signed(origin)?;
			let (raw, rights_block) = Self::read_rights_entry(
				relay_block, relay_proof, rights_proof, b"Ownership", content_id, &who,
			)?;
			let is_owner = match raw {
				Some(bytes) => {
					remote_types::OwnershipInfo::decode(&mut &bytes[..])
						.map_err(|_| Error::<T>::DecodingFailed)?;
					true
				},
				None => false,
			};
			Self::deposit_event(Event::OwnershipVerified {
				content_id, who, is_owner, relay_block, rights_block,
			});
			Ok(())
		}

		/// Verify `who`'s subscription to `content_id`. Active means the proven
		/// CCRMS block is before the subscription's expiry block.
		#[pallet::call_index(1)]
		#[pallet::weight(<T as Config>::VerifierWeightInfo::verify_subscription(Pallet::<T>::proof_bytes(relay_proof, rights_proof)))]
		pub fn verify_subscription(
			origin: OriginFor<T>,
			relay_block: u32,
			relay_proof: Vec<Vec<u8>>,
			rights_proof: Vec<Vec<u8>>,
			content_id: u32,
			who: T::AccountId,
		) -> DispatchResult {
			ensure_signed(origin)?;
			let (raw, rights_block) = Self::read_rights_entry(
				relay_block, relay_proof, rights_proof, b"Subscriptions", content_id, &who,
			)?;
			let (is_active, expiry_block) = match raw {
				Some(bytes) => {
					let info = remote_types::SubscriptionInfo::decode(&mut &bytes[..])
						.map_err(|_| Error::<T>::DecodingFailed)?;
					(rights_block < info.expiry_block, info.expiry_block)
				},
				None => (false, 0),
			};
			Self::deposit_event(Event::SubscriptionVerified {
				content_id, who, is_active, expiry_block, relay_block, rights_block,
			});
			Ok(())
		}

		/// Verify `who`'s pay-per-view balance for `content_id`.
		#[pallet::call_index(2)]
		#[pallet::weight(<T as Config>::VerifierWeightInfo::verify_view_pack(Pallet::<T>::proof_bytes(relay_proof, rights_proof)))]
		pub fn verify_view_pack(
			origin: OriginFor<T>,
			relay_block: u32,
			relay_proof: Vec<Vec<u8>>,
			rights_proof: Vec<Vec<u8>>,
			content_id: u32,
			who: T::AccountId,
		) -> DispatchResult {
			ensure_signed(origin)?;
			let (raw, rights_block) = Self::read_rights_entry(
				relay_block, relay_proof, rights_proof, b"ViewPacks", content_id, &who,
			)?;
			let (has_views, views_remaining) = match raw {
				Some(bytes) => {
					let info = remote_types::ViewPackInfo::decode(&mut &bytes[..])
						.map_err(|_| Error::<T>::DecodingFailed)?;
					(info.views_remaining > 0, info.views_remaining)
				},
				None => (false, 0),
			};
			Self::deposit_event(Event::ViewPackVerified {
				content_id, who, has_views, views_remaining, relay_block, rights_block,
			});
			Ok(())
		}
	}
}
