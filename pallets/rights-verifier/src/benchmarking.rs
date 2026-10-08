//! FRAME benchmarks for `pallet-rights-verifier` (Finding L).
//!
//! Each verification builds a genuine relay trie (holding the CCRMS head) and
//! a genuine CCRMS trie (holding the rights entry), records the relay root at
//! the end of a full `RelayRoots` window (worst-case search), and pads the
//! CCRMS proof with extra nodes to `b` bytes. The verifier hashes every node it
//! is given, so its cost grows with the total proof size.

use super::*;
use crate::pallet::{RelayRoots, RightsHeader};
use alloc::vec;
use alloc::vec::Vec;
use codec::Encode;
use frame::deps::frame_benchmarking::v2::*;
use frame::prelude::*;
use frame_system::RawOrigin;
use polkadot_sdk::sp_core::H256;
use polkadot_sdk::sp_runtime::traits::{BlakeTwo256, Header as _};
use polkadot_sdk::sp_trie::{trie_types::TrieDBMutBuilderV1, MemoryDB, TrieMut};

const RELAY_BLOCK: u32 = 1_000_000;
const RIGHTS_BLOCK: u32 = 50;
/// Upper end of the padding range; leaves room for the real nodes below
/// MAX_PROOF_BYTES.
const MAX_PADDING: u32 = 15_000;
const PAD_NODE: usize = 512;

/// Build a trie from `entries`; returns its root and all its nodes (a valid,
/// complete proof for any key in it).
fn trie(entries: &[(Vec<u8>, Vec<u8>)]) -> (H256, Vec<Vec<u8>>) {
	let mut db = MemoryDB::<BlakeTwo256>::default();
	let mut root = H256::default();
	{
		let mut t = TrieDBMutBuilderV1::<BlakeTwo256>::new(&mut db, &mut root).build();
		for (k, v) in entries {
			t.insert(k, v).expect("in-memory insert; qed");
		}
	}
	let nodes = db.drain().into_values().filter(|(_, rc)| *rc > 0).map(|(v, _)| v).collect();
	(root, nodes)
}

/// Extra nodes totalling `b` bytes (hashed by the verifier, never read).
fn padding(b: u32) -> Vec<Vec<u8>> {
	let mut out = Vec::new();
	let mut left = b as usize;
	let mut i: u32 = 0;
	while left > 0 {
		let n = left.min(PAD_NODE);
		let mut node = vec![0xAB; n];
		node[..4.min(n)].copy_from_slice(&i.to_le_bytes()[..4.min(n)]);
		out.push(node);
		left -= n;
		i += 1;
	}
	out
}

/// Set up proofs for `storage_name(0, who) = value`; returns (relay proof, rights proof).
fn setup<T: Config>(
	storage_name: &[u8],
	who: &T::AccountId,
	value: Vec<u8>,
	b: u32,
) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
	let key = Pallet::<T>::content_rights_key(storage_name, 0, who);
	let (state_root, mut rights_proof) =
		trie(&[(key, value), (b"other-entry".to_vec(), vec![1; 32])]);
	rights_proof.extend(padding(b));

	let header = RightsHeader::new(
		RIGHTS_BLOCK,
		Default::default(),
		state_root,
		Default::default(),
		Default::default(),
	);
	let (relay_root, relay_proof) = trie(&[
		(Pallet::<T>::para_head_key(T::RightsParaId::get()), header.encode().encode()),
		(b"other-relay-entry".to_vec(), vec![2; 32]),
	]);

	// Full window with the target relay block last (worst-case search).
	let max = T::MaxRelayRoots::get();
	let mut roots: Vec<(u32, H256)> =
		(1..max).map(|i| (RELAY_BLOCK - max + i, H256::repeat_byte(i as u8))).collect();
	roots.push((RELAY_BLOCK, relay_root));
	RelayRoots::<T>::put(BoundedVec::try_from(roots).expect("window size; qed"));
	(relay_proof, rights_proof)
}

#[benchmarks]
mod benchmarks {
	use super::*;

	#[benchmark]
	fn verify_ownership(b: Linear<0, MAX_PADDING>) {
		let caller: T::AccountId = whitelisted_caller();
		let who: T::AccountId = account("who", 0, 0);
		let value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();
		let (relay_proof, rights_proof) = setup::<T>(b"Ownership", &who, value, b);
		#[extrinsic_call]
		_(RawOrigin::Signed(caller), RELAY_BLOCK, relay_proof, rights_proof, 0, who);
	}

	#[benchmark]
	fn verify_subscription(b: Linear<0, MAX_PADDING>) {
		let caller: T::AccountId = whitelisted_caller();
		let who: T::AccountId = account("who", 0, 0);
		let value = remote_types::SubscriptionInfo {
			expiry_block: 100,
			auto_renew: true,
			child_item_id: 1,
		}
		.encode();
		let (relay_proof, rights_proof) = setup::<T>(b"Subscriptions", &who, value, b);
		#[extrinsic_call]
		_(RawOrigin::Signed(caller), RELAY_BLOCK, relay_proof, rights_proof, 0, who);
	}

	#[benchmark]
	fn verify_view_pack(b: Linear<0, MAX_PADDING>) {
		let caller: T::AccountId = whitelisted_caller();
		let who: T::AccountId = account("who", 0, 0);
		let value = remote_types::ViewPackInfo { views_remaining: 3, child_item_id: 1 }.encode();
		let (relay_proof, rights_proof) = setup::<T>(b"ViewPacks", &who, value, b);
		#[extrinsic_call]
		_(RawOrigin::Signed(caller), RELAY_BLOCK, relay_proof, rights_proof, 0, who);
	}

	/// Recording a new relay root into a full window (drops the oldest).
	#[benchmark]
	fn record_relay_root() {
		let max = T::MaxRelayRoots::get();
		let roots: Vec<(u32, H256)> = (0..max).map(|i| (i, H256::repeat_byte(i as u8))).collect();
		RelayRoots::<T>::put(BoundedVec::try_from(roots).expect("window size; qed"));
		T::RelayState::set_for_benchmarks(max + 1, H256::repeat_byte(0xEE));
		#[block]
		{
			Pallet::<T>::record_relay_root();
		}
		assert_eq!(RelayRoots::<T>::get().last().map(|(n, _)| *n), Some(max + 1));
	}

	impl_benchmark_test_suite!(Pallet, crate::mock::new_test_ext(), crate::mock::Test);
}
