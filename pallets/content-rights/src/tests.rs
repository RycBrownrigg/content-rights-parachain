use crate::{mock::*, pallet};
use frame::{
	deps::frame_support::{assert_noop, assert_ok},
	prelude::*,
};

fn default_title() -> BoundedVec<u8, ConstU32<128>> {
	b"Test Content".to_vec().try_into().unwrap()
}

/// Helper: register content and return the content_id (0 for first call).
fn register_default_content(creator: AccountId) -> u32 {
	let content_id = pallet::NextContentId::<Test>::get();
	assert_ok!(ContentRights::register_content(
		RuntimeOrigin::signed(creator),
		[0u8; 32],       // metadata_hash
		default_title(),
		100,              // subscription_price
		10,               // ppv_price
		500,              // ownership_price
		100,              // period_length (blocks)
	));
	content_id
}

// ==================== register_content ====================

#[test]
fn register_content_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let content_id = register_default_content(creator.clone());

		// Content stored correctly
		let content = pallet::Contents::<Test>::get(content_id).unwrap();
		assert_eq!(content.creator, creator);
		assert_eq!(content.subscription_price, 100);
		assert_eq!(content.ppv_price, 10);
		assert_eq!(content.ownership_price, 500);
		assert_eq!(content.period_length, 100);
		assert_eq!(content.content_item_id, 0);

		// NextContentId incremented
		assert_eq!(pallet::NextContentId::<Test>::get(), 1);

		// NextItemId for the collection starts at 1
		assert_eq!(pallet::NextItemId::<Test>::get(content.collection_id), 1);
	});
}

#[test]
fn register_multiple_contents() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let id0 = register_default_content(creator.clone());
		let id1 = register_default_content(creator.clone());

		assert_eq!(id0, 0);
		assert_eq!(id1, 1);
		assert_eq!(pallet::NextContentId::<Test>::get(), 2);

		// Each content gets its own collection
		let c0 = pallet::Contents::<Test>::get(0).unwrap();
		let c1 = pallet::Contents::<Test>::get(1).unwrap();
		assert_ne!(c0.collection_id, c1.collection_id);
	});
}

// ==================== subscribe ====================

#[test]
fn subscribe_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator.clone());

		let creator_balance_before = Balances::free_balance(&creator);

		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		// Creator received the subscription payment (minus NFT deposit costs on their side)
		// The payment amount (100) is transferred, but creator also pays item deposit for minting
		// Just verify creator balance increased
		assert!(Balances::free_balance(&creator) > creator_balance_before);

		// Subscription stored
		let sub = pallet::Subscriptions::<Test>::get(content_id, &user).unwrap();
		assert_eq!(sub.expiry_block, 1 + 100); // current block 1 + period 100

		// Child NFT nested
		let content = pallet::Contents::<Test>::get(content_id).unwrap();
		let children = pallet::Children::<Test>::get(content.collection_id, content.content_item_id);
		assert_eq!(children.len(), 1);
	});
}

#[test]
fn subscribe_fails_if_already_subscribed() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));
		assert_noop!(
			ContentRights::subscribe(RuntimeOrigin::signed(user), content_id),
			crate::Error::<Test>::SubscriptionAlreadyExists
		);
	});
}

#[test]
fn subscribe_fails_content_not_found() {
	new_test_ext().execute_with(|| {
		let user = account(2);
		assert_noop!(
			ContentRights::subscribe(RuntimeOrigin::signed(user), 999),
			crate::Error::<Test>::ContentNotFound
		);
	});
}

// ==================== renew_subscription ====================

#[test]
fn renew_subscription_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		// Advance past expiry (block 1 + period 100 = 101)
		System::set_block_number(101);

		assert_ok!(ContentRights::renew_subscription(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		let sub = pallet::Subscriptions::<Test>::get(content_id, &user).unwrap();
		assert_eq!(sub.expiry_block, 101 + 100); // renewed from block 101
	});
}

#[test]
fn renew_fails_if_not_expired() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		// Still at block 1, subscription expires at 101
		assert_noop!(
			ContentRights::renew_subscription(RuntimeOrigin::signed(user), content_id),
			crate::Error::<Test>::SubscriptionNotExpired
		);
	});
}

#[test]
fn renew_fails_if_no_subscription() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_noop!(
			ContentRights::renew_subscription(RuntimeOrigin::signed(user), content_id),
			crate::Error::<Test>::SubscriptionNotFound
		);
	});
}

// ==================== purchase_views ====================

#[test]
fn purchase_views_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator.clone());

		let creator_balance_before = Balances::free_balance(&creator);

		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(user.clone()),
			content_id,
			5, // 5 views
		));

		// Creator received 50 (5 * 10), minus NFT deposit costs
		assert!(Balances::free_balance(&creator) > creator_balance_before);

		let pack = pallet::ViewPacks::<Test>::get(content_id, &user).unwrap();
		assert_eq!(pack.views_remaining, 5);
	});
}

// ==================== consume_view ====================

#[test]
fn consume_view_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(user.clone()),
			content_id,
			3,
		));

		// Consume one view
		assert_ok!(ContentRights::consume_view(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		let pack = pallet::ViewPacks::<Test>::get(content_id, &user).unwrap();
		assert_eq!(pack.views_remaining, 2);
	});
}

#[test]
fn consume_view_burns_nft_at_zero() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(user.clone()),
			content_id,
			1, // only 1 view
		));

		assert_ok!(ContentRights::consume_view(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		// ViewPack removed
		assert!(pallet::ViewPacks::<Test>::get(content_id, &user).is_none());

		// Nesting cleaned up
		let content = pallet::Contents::<Test>::get(content_id).unwrap();
		let children = pallet::Children::<Test>::get(content.collection_id, content.content_item_id);
		assert_eq!(children.len(), 0);
	});
}

#[test]
fn consume_view_fails_no_pack() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_noop!(
			ContentRights::consume_view(RuntimeOrigin::signed(user), content_id),
			crate::Error::<Test>::ViewPackNotFound
		);
	});
}

// ==================== purchase_ownership ====================

#[test]
fn purchase_ownership_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator.clone());

		let creator_balance_before = Balances::free_balance(&creator);

		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		// Creator received 500, minus NFT deposit costs
		assert!(Balances::free_balance(&creator) > creator_balance_before);

		// Ownership recorded
		assert!(pallet::Ownership::<Test>::get(content_id, &user));
	});
}

#[test]
fn purchase_ownership_fails_if_already_owned() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));
		assert_noop!(
			ContentRights::purchase_ownership(RuntimeOrigin::signed(user), content_id),
			crate::Error::<Test>::AlreadyOwned
		);
	});
}

// ==================== check_access ====================

#[test]
fn check_access_with_ownership() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		assert_ok!(ContentRights::check_access(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		// Verify the AccessChecked event was emitted with has_access = true
		System::assert_has_event(
			crate::Event::<Test>::AccessChecked {
				content_id,
				who: user,
				has_access: true,
			}
			.into(),
		);
	});
}

#[test]
fn check_access_with_active_subscription() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		assert_ok!(ContentRights::check_access(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		System::assert_has_event(
			crate::Event::<Test>::AccessChecked {
				content_id,
				who: user,
				has_access: true,
			}
			.into(),
		);
	});
}

#[test]
fn check_access_with_expired_subscription_no_access() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		// Advance past expiry
		System::set_block_number(200);

		assert_ok!(ContentRights::check_access(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		System::assert_has_event(
			crate::Event::<Test>::AccessChecked {
				content_id,
				who: user,
				has_access: false,
			}
			.into(),
		);
	});
}

#[test]
fn check_access_with_views_remaining() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(user.clone()),
			content_id,
			3,
		));

		assert_ok!(ContentRights::check_access(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		System::assert_has_event(
			crate::Event::<Test>::AccessChecked {
				content_id,
				who: user,
				has_access: true,
			}
			.into(),
		);
	});
}

#[test]
fn check_access_no_rights_no_access() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::check_access(
			RuntimeOrigin::signed(user.clone()),
			content_id,
		));

		System::assert_has_event(
			crate::Event::<Test>::AccessChecked {
				content_id,
				who: user,
				has_access: false,
			}
			.into(),
		);
	});
}

#[test]
fn check_access_fails_content_not_found() {
	new_test_ext().execute_with(|| {
		let user = account(2);
		assert_noop!(
			ContentRights::check_access(RuntimeOrigin::signed(user), 999),
			crate::Error::<Test>::ContentNotFound
		);
	});
}

// ==================== nesting ====================

#[test]
fn nesting_multiple_children() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let user_a = account(2);
		let user_b = account(3);
		let content_id = register_default_content(creator);

		// Subscribe and purchase views — both create child NFTs
		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(user_a.clone()),
			content_id,
		));
		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(user_b.clone()),
			content_id,
			2,
		));

		let content = pallet::Contents::<Test>::get(content_id).unwrap();
		let children = pallet::Children::<Test>::get(content.collection_id, content.content_item_id);
		assert_eq!(children.len(), 2);

		// Both children have parent records
		for &(col, item) in children.iter() {
			let parent = pallet::Parent::<Test>::get(col, item).unwrap();
			assert_eq!(parent, (content.collection_id, content.content_item_id));
		}
	});
}
