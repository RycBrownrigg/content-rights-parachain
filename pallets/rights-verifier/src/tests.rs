//! Unit tests for cross-chain rights verification via storage proofs.
//!
//! Each test builds two in-memory tries: a CCRMS state trie holding rights
//! entries, and a relay-chain state trie whose `Paras::Heads(100)` entry is a
//! CCRMS header committing to that state root. The relay root is "supplied by
//! the validators" (recorded by the pallet), never by the caller.

use crate::{mock::*, pallet::RightsHeader, remote_types};
use codec::Encode;
use frame::deps::{
	frame_support::{assert_noop, assert_ok, traits::Hooks, StorageHasher},
	sp_core::H256,
	sp_runtime::traits::{BlakeTwo256, Header as _},
};
use polkadot_sdk::sp_state_machine;

type AccountId = <Test as frame::deps::frame_system::Config>::AccountId;

const RELAY_BLOCK: u32 = 1_000;

/// CCRMS storage key of a content-rights double-map entry.
fn rights_key(storage_name: &[u8], content_id: u32, who: &AccountId) -> Vec<u8> {
	let mut key = Vec::new();
	key.extend_from_slice(&frame::deps::sp_core::hashing::twox_128(b"ContentRights"));
	key.extend_from_slice(&frame::deps::sp_core::hashing::twox_128(storage_name));
	key.extend_from_slice(&frame::deps::frame_support::Blake2_128Concat::hash(&content_id.encode()));
	key.extend_from_slice(&frame::deps::frame_support::Blake2_128Concat::hash(&who.encode()));
	key
}

/// Build a trie from `entries` and prove `proof_keys`; returns (root, proof).
fn trie_and_proof(entries: &[(Vec<u8>, Vec<u8>)], proof_keys: &[Vec<u8>]) -> (H256, Vec<Vec<u8>>) {
	let mut backend = sp_state_machine::InMemoryBackend::<BlakeTwo256>::default();
	let collection: Vec<(Vec<u8>, Option<Vec<u8>>)> =
		entries.iter().map(|(k, v)| (k.clone(), Some(v.clone()))).collect();
	backend.insert(vec![(None, collection)], Default::default());
	let root = *backend.root();
	let proof = sp_state_machine::prove_read(backend, proof_keys).unwrap();
	(H256::from(root), proof.into_nodes().into_iter().collect())
}

/// A CCRMS header at `number` committing to `state_root`.
fn rights_header(number: u32, state_root: H256) -> RightsHeader {
	RightsHeader::new(number, Default::default(), state_root, Default::default(), Default::default())
}

/// Relay trie holding `header` as the head of para 100. Returns (relay root, proof).
fn relay_with_head(header: &RightsHeader) -> (H256, Vec<Vec<u8>>) {
	let key = RightsVerifier::para_head_key(100);
	// `Paras::Heads` stores HeadData(Vec<u8>) = the encoded header bytes.
	let value = header.encode().encode();
	trie_and_proof(&[(key.clone(), value)], &[key])
}

/// Record `relay_root` for `relay_block` the way a block does it: the relay
/// parent is set (as by set_validation_data) and on_finalize runs.
fn record(relay_block: u32, relay_root: H256) {
	MockRelayParent::set(&Some((relay_block, relay_root)));
	RightsVerifier::on_finalize(1);
}

/// Set up both proofs for one rights entry; returns (relay proof, rights proof).
fn prove_entry(
	key: Vec<u8>,
	value: Option<Vec<u8>>,
	rights_block: u32,
) -> (Vec<Vec<u8>>, Vec<Vec<u8>>) {
	let entries: Vec<(Vec<u8>, Vec<u8>)> = match value {
		Some(v) => vec![(key.clone(), v)],
		// Absence proof: the trie holds an unrelated entry only.
		None => vec![(b"unrelated".to_vec(), vec![1])],
	};
	let (state_root, rights_proof) = trie_and_proof(&entries, &[key]);
	let (relay_root, relay_proof) = relay_with_head(&rights_header(rights_block, state_root));
	record(RELAY_BLOCK, relay_root);
	(relay_proof, rights_proof)
}

#[test]
fn para_head_prefix_is_paras_heads() {
	let mut prefix = frame::deps::sp_core::hashing::twox_128(b"Paras").to_vec();
	prefix.extend_from_slice(&frame::deps::sp_core::hashing::twox_128(b"Heads"));
	assert_eq!(RightsVerifier::para_head_key(100)[..32], prefix[..]);
}

// ==================== verify_ownership ====================

#[test]
fn verify_ownership_with_valid_proofs_returns_true() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Ownership", 0, &who);
		let value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();
		let (relay_proof, rights_proof) = prove_entry(key, Some(value), 50);

		assert_ok!(RightsVerifier::verify_ownership(
			RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, rights_proof, 0, who,
		));
		System::assert_has_event(
			crate::Event::<Test>::OwnershipVerified {
				content_id: 0, who, is_owner: true, relay_block: RELAY_BLOCK, rights_block: 50,
			}
			.into(),
		);
	});
}

#[test]
fn verify_ownership_with_no_entry_returns_false() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Ownership", 0, &who);
		let (relay_proof, rights_proof) = prove_entry(key, None, 50);

		assert_ok!(RightsVerifier::verify_ownership(
			RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, rights_proof, 0, who,
		));
		System::assert_has_event(
			crate::Event::<Test>::OwnershipVerified {
				content_id: 0, who, is_owner: false, relay_block: RELAY_BLOCK, rights_block: 50,
			}
			.into(),
		);
	});
}

/// A forged CCRMS trie (claiming ownership) fails against the state root in
/// the genuine header: the caller cannot choose the CCRMS root.
#[test]
fn forged_rights_proof_is_rejected() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Ownership", 0, &who);
		// Genuine CCRMS state: no ownership for `who`.
		let (genuine_root, _) = trie_and_proof(&[(b"unrelated".to_vec(), vec![1])], &[]);
		let (relay_root, relay_proof) = relay_with_head(&rights_header(50, genuine_root));
		record(RELAY_BLOCK, relay_root);
		// Attacker's trie with a forged ownership entry.
		let value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();
		let (_, forged_proof) = trie_and_proof(&[(key.clone(), value)], &[key]);

		assert_noop!(
			RightsVerifier::verify_ownership(
				RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, forged_proof, 0, who,
			),
			crate::Error::<Test>::InvalidProof
		);
	});
}

/// A forged relay trie (with a head committing to the attacker's CCRMS root)
/// fails against the relay root the validators supplied.
#[test]
fn forged_relay_proof_is_rejected() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Ownership", 0, &who);
		let value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();
		let (forged_state, rights_proof) = trie_and_proof(&[(key.clone(), value)], &[key]);
		let (_, forged_relay_proof) = relay_with_head(&rights_header(50, forged_state));
		// The genuine relay state at RELAY_BLOCK has a different root.
		let (genuine_relay_root, _) = trie_and_proof(&[(b"other".to_vec(), vec![2])], &[]);
		record(RELAY_BLOCK, genuine_relay_root);

		assert_noop!(
			RightsVerifier::verify_ownership(
				RuntimeOrigin::signed(1), RELAY_BLOCK, forged_relay_proof, rights_proof, 0, who,
			),
			crate::Error::<Test>::InvalidProof
		);
	});
}

#[test]
fn unknown_relay_block_is_rejected() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Ownership", 0, &who);
		let value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();
		let (relay_proof, rights_proof) = prove_entry(key, Some(value), 50);

		assert_noop!(
			RightsVerifier::verify_ownership(
				RuntimeOrigin::signed(1), RELAY_BLOCK + 1, relay_proof, rights_proof, 0, who,
			),
			crate::Error::<Test>::UnknownRelayBlock
		);
	});
}

/// A relay proof that shows no head for para 100 is rejected.
#[test]
fn missing_rights_head_is_rejected() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let head_key = RightsVerifier::para_head_key(100);
		let (relay_root, relay_proof) =
			trie_and_proof(&[(RightsVerifier::para_head_key(200), vec![0])], &[head_key]);
		record(RELAY_BLOCK, relay_root);

		assert_noop!(
			RightsVerifier::verify_ownership(
				RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, vec![], 0, who,
			),
			crate::Error::<Test>::NoRightsHead
		);
	});
}

// ==================== verify_subscription ====================

/// Active: the proven CCRMS block (50) is before expiry (100).
#[test]
fn verify_subscription_active_before_expiry() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Subscriptions", 0, &who);
		let value = remote_types::SubscriptionInfo { expiry_block: 100, auto_renew: false, child_item_id: 1 }
			.encode();
		let (relay_proof, rights_proof) = prove_entry(key, Some(value), 50);

		assert_ok!(RightsVerifier::verify_subscription(
			RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, rights_proof, 0, who,
		));
		System::assert_has_event(
			crate::Event::<Test>::SubscriptionVerified {
				content_id: 0, who, is_active: true, expiry_block: 100,
				relay_block: RELAY_BLOCK, rights_block: 50,
			}
			.into(),
		);
	});
}

/// Expired: the entry still exists, but the proven CCRMS block (150) is past expiry.
#[test]
fn verify_subscription_expired_entry_is_inactive() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Subscriptions", 0, &who);
		let value = remote_types::SubscriptionInfo { expiry_block: 100, auto_renew: false, child_item_id: 1 }
			.encode();
		let (relay_proof, rights_proof) = prove_entry(key, Some(value), 150);

		assert_ok!(RightsVerifier::verify_subscription(
			RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, rights_proof, 0, who,
		));
		System::assert_has_event(
			crate::Event::<Test>::SubscriptionVerified {
				content_id: 0, who, is_active: false, expiry_block: 100,
				relay_block: RELAY_BLOCK, rights_block: 150,
			}
			.into(),
		);
	});
}

#[test]
fn verify_subscription_not_found() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"Subscriptions", 0, &who);
		let (relay_proof, rights_proof) = prove_entry(key, None, 50);

		assert_ok!(RightsVerifier::verify_subscription(
			RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, rights_proof, 0, who,
		));
		System::assert_has_event(
			crate::Event::<Test>::SubscriptionVerified {
				content_id: 0, who, is_active: false, expiry_block: 0,
				relay_block: RELAY_BLOCK, rights_block: 50,
			}
			.into(),
		);
	});
}

// ==================== verify_view_pack ====================

#[test]
fn verify_view_pack_with_views_remaining() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"ViewPacks", 0, &who);
		let value = remote_types::ViewPackInfo { views_remaining: 3, child_item_id: 1 }.encode();
		let (relay_proof, rights_proof) = prove_entry(key, Some(value), 50);

		assert_ok!(RightsVerifier::verify_view_pack(
			RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, rights_proof, 0, who,
		));
		System::assert_has_event(
			crate::Event::<Test>::ViewPackVerified {
				content_id: 0, who, has_views: true, views_remaining: 3,
				relay_block: RELAY_BLOCK, rights_block: 50,
			}
			.into(),
		);
	});
}

#[test]
fn verify_view_pack_not_found() {
	new_test_ext().execute_with(|| {
		let who: AccountId = 2;
		let key = rights_key(b"ViewPacks", 0, &who);
		let (relay_proof, rights_proof) = prove_entry(key, None, 50);

		assert_ok!(RightsVerifier::verify_view_pack(
			RuntimeOrigin::signed(1), RELAY_BLOCK, relay_proof, rights_proof, 0, who,
		));
		System::assert_has_event(
			crate::Event::<Test>::ViewPackVerified {
				content_id: 0, who, has_views: false, views_remaining: 0,
				relay_block: RELAY_BLOCK, rights_block: 50,
			}
			.into(),
		);
	});
}

// ==================== relay-root window ====================

/// Roots are recorded once per relay parent and the window keeps the most
/// recent MaxRelayRoots (4 in the mock); older relay blocks expire.
#[test]
fn relay_root_window_deduplicates_and_expires() {
	new_test_ext().execute_with(|| {
		let root = |n: u8| H256::repeat_byte(n);
		record(1, root(1));
		record(1, root(1)); // same relay parent in two blocks: stored once
		for n in 2..=5u8 {
			record(n as u32, root(n));
		}
		let kept: Vec<u32> = crate::RelayRoots::<Test>::get().iter().map(|(n, _)| *n).collect();
		assert_eq!(kept, vec![2, 3, 4, 5]);

		// Nothing is recorded before the relay parent is known.
		MockRelayParent::set(&None);
		RightsVerifier::on_finalize(2);
		assert_eq!(crate::RelayRoots::<Test>::get().len(), 4);
	});
}
