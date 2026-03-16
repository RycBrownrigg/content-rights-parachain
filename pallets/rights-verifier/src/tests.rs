//! Unit tests for cross-chain rights verification via storage proofs.
//!
//! Tests construct an in-memory trie with content-rights storage entries,
//! generate Merkle proofs, and verify them through the pallet's extrinsics.

use crate::{mock::*, remote_types};
use codec::Encode;
use frame::{
	deps::{
		frame_support::{assert_noop, assert_ok, StorageHasher},
		sp_core::H256,
		sp_runtime::traits::BlakeTwo256,
	},
};
use polkadot_sdk::sp_state_machine;

type AccountId = <Test as frame::deps::frame_system::Config>::AccountId;

/// Build the full storage key for a content-rights StorageDoubleMap entry,
/// matching the key format used by the pallet on the remote chain.
fn build_storage_key(storage_name: &[u8], content_id: u32, who: &AccountId) -> Vec<u8> {
	let pallet_hash = frame::deps::sp_core::hashing::twox_128(b"ContentRights");
	let storage_hash = frame::deps::sp_core::hashing::twox_128(storage_name);
	let key1 = frame::deps::frame_support::Blake2_128Concat::hash(&content_id.encode());
	let key2 = frame::deps::frame_support::Blake2_128Concat::hash(&who.encode());

	let mut key = Vec::new();
	key.extend_from_slice(&pallet_hash);
	key.extend_from_slice(&storage_hash);
	key.extend_from_slice(&key1);
	key.extend_from_slice(&key2);
	key
}

/// Insert key-value pairs into a trie and return (root, proof_nodes).
///
/// Uses `prove_read` from `sp_state_machine` which produces proofs compatible
/// with `StorageProof::new().into_memory_db()` reconstruction.
fn build_trie_and_proof(
	entries: &[(Vec<u8>, Vec<u8>)],
	proof_keys: &[Vec<u8>],
) -> (H256, Vec<Vec<u8>>) {
	let mut backend = sp_state_machine::InMemoryBackend::<BlakeTwo256>::default();

	// Insert entries: format is Vec<(Option<ChildInfo>, StorageCollection)>
	let storage_collection: Vec<(Vec<u8>, Option<Vec<u8>>)> = entries
		.iter()
		.map(|(k, v)| (k.clone(), Some(v.clone())))
		.collect();
	backend.insert(vec![(None, storage_collection)], Default::default());

	let root = *backend.root();

	// Generate the storage proof
	let proof = sp_state_machine::prove_read(backend, proof_keys).unwrap();

	(H256::from(root), proof.into_nodes().into_iter().collect())
}

// ==================== verify_ownership ====================

#[test]
fn verify_ownership_with_valid_proof_returns_true() {
	new_test_ext().execute_with(|| {
		let content_id = 0u32;
		let who: AccountId = 2;

		let key = build_storage_key(b"Ownership", content_id, &who);
		let value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();

		let (root, proof) = build_trie_and_proof(&[(key.clone(), value)], &[key]);

		assert_ok!(RightsVerifier::verify_ownership(
			RuntimeOrigin::signed(1),
			root,
			proof,
			content_id,
			who,
		));

		System::assert_has_event(
			crate::Event::<Test>::OwnershipVerified {
				content_id,
				who,
				is_owner: true,
				state_root: root,
			}
			.into(),
		);
	});
}

#[test]
fn verify_ownership_with_no_entry_returns_false() {
	new_test_ext().execute_with(|| {
		let content_id = 0u32;
		let who: AccountId = 2;
		let other: AccountId = 3;

		// Trie has ownership for `other`, not `who`
		let other_key = build_storage_key(b"Ownership", content_id, &other);
		let other_value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();

		// We need proof for `who`'s key (which doesn't exist)
		let who_key = build_storage_key(b"Ownership", content_id, &who);

		let (root, proof) = build_trie_and_proof(
			&[(other_key, other_value)],
			&[who_key],
		);

		assert_ok!(RightsVerifier::verify_ownership(
			RuntimeOrigin::signed(1),
			root,
			proof,
			content_id,
			who,
		));

		System::assert_has_event(
			crate::Event::<Test>::OwnershipVerified {
				content_id,
				who,
				is_owner: false,
				state_root: root,
			}
			.into(),
		);
	});
}

#[test]
fn verify_ownership_with_wrong_root_fails() {
	new_test_ext().execute_with(|| {
		let content_id = 0u32;
		let who: AccountId = 2;

		let key = build_storage_key(b"Ownership", content_id, &who);
		let value = remote_types::OwnershipInfo { child_item_id: 1 }.encode();

		let (_root, proof) = build_trie_and_proof(&[(key.clone(), value)], &[key]);

		// Use a wrong state root
		let wrong_root = H256::from([0xaa; 32]);

		assert_noop!(
			RightsVerifier::verify_ownership(
				RuntimeOrigin::signed(1),
				wrong_root,
				proof,
				content_id,
				who,
			),
			crate::Error::<Test>::InvalidProof
		);
	});
}

// ==================== verify_subscription ====================

#[test]
fn verify_subscription_with_valid_proof() {
	new_test_ext().execute_with(|| {
		let content_id = 0u32;
		let who: AccountId = 2;

		let key = build_storage_key(b"Subscriptions", content_id, &who);
		let value = remote_types::SubscriptionInfo {
			expiry_block: 500,
			auto_renew: false,
			child_item_id: 2,
		}
		.encode();

		let (root, proof) = build_trie_and_proof(&[(key.clone(), value)], &[key]);

		assert_ok!(RightsVerifier::verify_subscription(
			RuntimeOrigin::signed(1),
			root,
			proof,
			content_id,
			who,
		));

		System::assert_has_event(
			crate::Event::<Test>::SubscriptionVerified {
				content_id,
				who,
				is_active: true,
				expiry_block: 500,
				state_root: root,
			}
			.into(),
		);
	});
}

#[test]
fn verify_subscription_not_found() {
	new_test_ext().execute_with(|| {
		let content_id = 0u32;
		let who: AccountId = 2;
		let other: AccountId = 3;

		let other_key = build_storage_key(b"Subscriptions", content_id, &other);
		let other_value = remote_types::SubscriptionInfo {
			expiry_block: 500,
			auto_renew: false,
			child_item_id: 2,
		}
		.encode();

		let who_key = build_storage_key(b"Subscriptions", content_id, &who);
		let (root, proof) = build_trie_and_proof(
			&[(other_key, other_value)],
			&[who_key],
		);

		assert_ok!(RightsVerifier::verify_subscription(
			RuntimeOrigin::signed(1),
			root,
			proof,
			content_id,
			who,
		));

		System::assert_has_event(
			crate::Event::<Test>::SubscriptionVerified {
				content_id,
				who,
				is_active: false,
				expiry_block: 0,
				state_root: root,
			}
			.into(),
		);
	});
}

// ==================== verify_view_pack ====================

#[test]
fn verify_view_pack_with_views_remaining() {
	new_test_ext().execute_with(|| {
		let content_id = 0u32;
		let who: AccountId = 2;

		let key = build_storage_key(b"ViewPacks", content_id, &who);
		let value = remote_types::ViewPackInfo {
			views_remaining: 7,
			child_item_id: 3,
		}
		.encode();

		let (root, proof) = build_trie_and_proof(&[(key.clone(), value)], &[key]);

		assert_ok!(RightsVerifier::verify_view_pack(
			RuntimeOrigin::signed(1),
			root,
			proof,
			content_id,
			who,
		));

		System::assert_has_event(
			crate::Event::<Test>::ViewPackVerified {
				content_id,
				who,
				has_views: true,
				views_remaining: 7,
				state_root: root,
			}
			.into(),
		);
	});
}

#[test]
fn verify_view_pack_not_found() {
	new_test_ext().execute_with(|| {
		let content_id = 0u32;
		let who: AccountId = 2;
		let other: AccountId = 3;

		let other_key = build_storage_key(b"ViewPacks", content_id, &other);
		let other_value = remote_types::ViewPackInfo {
			views_remaining: 5,
			child_item_id: 3,
		}
		.encode();

		let who_key = build_storage_key(b"ViewPacks", content_id, &who);
		let (root, proof) = build_trie_and_proof(
			&[(other_key, other_value)],
			&[who_key],
		);

		assert_ok!(RightsVerifier::verify_view_pack(
			RuntimeOrigin::signed(1),
			root,
			proof,
			content_id,
			who,
		));

		System::assert_has_event(
			crate::Event::<Test>::ViewPackVerified {
				content_id,
				who,
				has_views: false,
				views_remaining: 0,
				state_root: root,
			}
			.into(),
		);
	});
}
