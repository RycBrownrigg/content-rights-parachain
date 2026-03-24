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
		assert!(pallet::Ownership::<Test>::get(content_id, &user).is_some());
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

// ==================== xcm_subscribe ====================

#[test]
fn xcm_subscribe_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3); // sovereign account (payer)
		let beneficiary = account(2); // remote user (beneficiary)
		let content_id = register_default_content(creator.clone());

		let creator_balance_before = Balances::free_balance(&creator);

		assert_ok!(ContentRights::xcm_subscribe(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			beneficiary.clone(),
		));

		// Creator received payment
		assert!(Balances::free_balance(&creator) > creator_balance_before);

		// Subscription stored for beneficiary, not payer
		let sub = pallet::Subscriptions::<Test>::get(content_id, &beneficiary).unwrap();
		assert_eq!(sub.expiry_block, 1 + 100);
		assert!(pallet::Subscriptions::<Test>::get(content_id, &payer).is_none());

		// Cross-chain event emitted
		System::assert_has_event(
			crate::Event::<Test>::CrossChainSubscriptionCreated {
				content_id,
				beneficiary,
				payer,
				expiry_block: 1 + 100,
			}
			.into(),
		);
	});
}

#[test]
fn xcm_subscribe_fails_already_subscribed() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3);
		let beneficiary = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::xcm_subscribe(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			beneficiary.clone(),
		));
		assert_noop!(
			ContentRights::xcm_subscribe(
				RuntimeOrigin::signed(payer),
				content_id,
				beneficiary,
			),
			crate::Error::<Test>::SubscriptionAlreadyExists
		);
	});
}

// ==================== xcm_renew_subscription ====================

#[test]
fn xcm_renew_subscription_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3);
		let beneficiary = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::xcm_subscribe(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			beneficiary.clone(),
		));

		// Advance past expiry
		System::set_block_number(101);

		assert_ok!(ContentRights::xcm_renew_subscription(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			beneficiary.clone(),
		));

		let sub = pallet::Subscriptions::<Test>::get(content_id, &beneficiary).unwrap();
		assert_eq!(sub.expiry_block, 101 + 100);

		System::assert_has_event(
			crate::Event::<Test>::CrossChainSubscriptionRenewed {
				content_id,
				beneficiary,
				payer,
				new_expiry_block: 201,
			}
			.into(),
		);
	});
}

// ==================== xcm_purchase_views ====================

#[test]
fn xcm_purchase_views_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3);
		let beneficiary = account(2);
		let content_id = register_default_content(creator.clone());

		let creator_balance_before = Balances::free_balance(&creator);

		assert_ok!(ContentRights::xcm_purchase_views(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			beneficiary.clone(),
			5,
		));

		assert!(Balances::free_balance(&creator) > creator_balance_before);

		// View pack stored for beneficiary
		let pack = pallet::ViewPacks::<Test>::get(content_id, &beneficiary).unwrap();
		assert_eq!(pack.views_remaining, 5);
		assert!(pallet::ViewPacks::<Test>::get(content_id, &payer).is_none());

		System::assert_has_event(
			crate::Event::<Test>::CrossChainViewPackPurchased {
				content_id,
				beneficiary,
				payer,
				views: 5,
			}
			.into(),
		);
	});
}

// ==================== xcm_purchase_ownership ====================

#[test]
fn xcm_purchase_ownership_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3);
		let beneficiary = account(2);
		let content_id = register_default_content(creator.clone());

		let creator_balance_before = Balances::free_balance(&creator);

		assert_ok!(ContentRights::xcm_purchase_ownership(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			beneficiary.clone(),
		));

		assert!(Balances::free_balance(&creator) > creator_balance_before);

		// Ownership recorded for beneficiary, not payer
		assert!(pallet::Ownership::<Test>::get(content_id, &beneficiary).is_some());
		assert!(pallet::Ownership::<Test>::get(content_id, &payer).is_none());

		System::assert_has_event(
			crate::Event::<Test>::CrossChainOwnershipPurchased {
				content_id,
				beneficiary,
				payer,
			}
			.into(),
		);
	});
}

#[test]
fn xcm_purchase_ownership_fails_already_owned() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3);
		let beneficiary = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::xcm_purchase_ownership(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			beneficiary.clone(),
		));
		assert_noop!(
			ContentRights::xcm_purchase_ownership(
				RuntimeOrigin::signed(payer),
				content_id,
				beneficiary,
			),
			crate::Error::<Test>::AlreadyOwned
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

// ==================== transfer_ownership ====================

#[test]
fn transfer_ownership_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let owner = account(2);
		let recipient = account(3);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(owner.clone()),
			content_id,
		));

		// Verify owner has it before transfer
		assert!(pallet::Ownership::<Test>::get(content_id, &owner).is_some());

		assert_ok!(ContentRights::transfer_ownership(
			RuntimeOrigin::signed(owner.clone()),
			content_id,
			recipient.clone(),
		));

		// Old owner no longer has it
		assert!(pallet::Ownership::<Test>::get(content_id, &owner).is_none());
		// Recipient now owns it
		assert!(pallet::Ownership::<Test>::get(content_id, &recipient).is_some());

		// NFT nesting updated: still 1 child (old burned, new minted)
		let content = pallet::Contents::<Test>::get(content_id).unwrap();
		let children =
			pallet::Children::<Test>::get(content.collection_id, content.content_item_id);
		assert_eq!(children.len(), 1);

		System::assert_has_event(
			crate::Event::<Test>::OwnershipTransferred {
				content_id,
				from: owner,
				to: recipient,
			}
			.into(),
		);
	});
}

#[test]
fn transfer_ownership_fails_not_owned() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let not_owner = account(2);
		let recipient = account(3);
		let content_id = register_default_content(creator);

		assert_noop!(
			ContentRights::transfer_ownership(
				RuntimeOrigin::signed(not_owner),
				content_id,
				recipient,
			),
			crate::Error::<Test>::OwnershipNotFound
		);
	});
}

#[test]
fn transfer_ownership_fails_recipient_already_owns() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let owner_a = account(2);
		let owner_b = account(3);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(owner_a.clone()),
			content_id,
		));
		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(owner_b.clone()),
			content_id,
		));

		assert_noop!(
			ContentRights::transfer_ownership(
				RuntimeOrigin::signed(owner_a),
				content_id,
				owner_b,
			),
			crate::Error::<Test>::AlreadyOwned
		);
	});
}

// ==================== xcm_transfer_ownership ====================

#[test]
fn xcm_transfer_ownership_works() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3); // sovereign account
		let owner = account(2);
		let recipient = account(4);
		let content_id = register_default_content(creator);

		// First purchase ownership for the owner via XCM
		assert_ok!(ContentRights::xcm_purchase_ownership(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			owner.clone(),
		));

		// Now transfer via XCM
		assert_ok!(ContentRights::xcm_transfer_ownership(
			RuntimeOrigin::signed(payer.clone()),
			content_id,
			owner.clone(),
			recipient.clone(),
		));

		// Old owner no longer has it
		assert!(pallet::Ownership::<Test>::get(content_id, &owner).is_none());
		// Recipient now owns it
		assert!(pallet::Ownership::<Test>::get(content_id, &recipient).is_some());

		System::assert_has_event(
			crate::Event::<Test>::CrossChainOwnershipTransferred {
				content_id,
				from: owner,
				to: recipient,
				authorizer: payer,
			}
			.into(),
		);
	});
}

#[test]
fn xcm_transfer_ownership_fails_not_owned() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let payer = account(3);
		let not_owner = account(2);
		let recipient = account(4);
		let content_id = register_default_content(creator);

		assert_noop!(
			ContentRights::xcm_transfer_ownership(
				RuntimeOrigin::signed(payer),
				content_id,
				not_owner,
				recipient,
			),
			crate::Error::<Test>::OwnershipNotFound
		);
	});
}

// ==================== Security Tests (Week 18) ====================

// Security-focused tests for authorization gaps, edge cases,
// and boundary conditions identified during security review.

/// FINDING B: Any signed account can call xcm_transfer_ownership
/// and transfer someone else's ownership without authorization.
#[test]
fn security_xcm_transfer_ownership_any_account_can_steal() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let owner = account(2);
		let attacker = account(3);
		let attacker_alt = account(4);
		let content_id = register_default_content(creator);

		// Owner legitimately purchases ownership
		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(owner.clone()),
			content_id,
		));
		assert!(pallet::Ownership::<Test>::get(content_id, &owner).is_some());

		// Attacker can steal ownership without owner's consent
		assert_ok!(ContentRights::xcm_transfer_ownership(
			RuntimeOrigin::signed(attacker),
			content_id,
			owner.clone(),
			attacker_alt.clone(),
		));

		// Owner lost their content
		assert!(pallet::Ownership::<Test>::get(content_id, &owner).is_none());
		// Attacker's alt now owns it
		assert!(pallet::Ownership::<Test>::get(content_id, &attacker_alt).is_some());
	});
}

/// Register content with all prices at zero — creates free content.
#[test]
fn security_zero_price_content_registration() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let subscriber = account(2);

		let content_id = pallet::NextContentId::<Test>::get();
		assert_ok!(ContentRights::register_content(
			RuntimeOrigin::signed(creator),
			[0u8; 32],
			default_title(),
			0, 0, 0, 100,
		));

		// Subscribe for free
		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(subscriber.clone()),
			content_id,
		));
		assert!(pallet::Subscriptions::<Test>::get(content_id, &subscriber).is_some());
	});
}

/// Purchase 0 views — creates a useless view pack.
#[test]
fn security_zero_views_purchase() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let buyer = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(buyer.clone()),
			content_id,
			0,
		));

		let pack = pallet::ViewPacks::<Test>::get(content_id, &buyer).unwrap();
		assert_eq!(pack.views_remaining, 0);

		assert_noop!(
			ContentRights::consume_view(RuntimeOrigin::signed(buyer), content_id),
			crate::Error::<Test>::NoViewsRemaining
		);
	});
}

/// Creator subscribes to their own content — self-payment.
/// Documents that self-subscription is allowed and the payment
/// (transfer from self to self) still deducts due to Substrate's
/// fungible::Mutate implementation.
#[test]
fn security_self_subscribe_as_creator() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let content_id = register_default_content(creator.clone());

		assert_ok!(ContentRights::subscribe(
			RuntimeOrigin::signed(creator.clone()),
			content_id,
		));

		// Self-subscription succeeds — creator can subscribe to own content
		assert!(pallet::Subscriptions::<Test>::get(content_id, &creator).is_some());
	});
}

/// Fill to MaxChildren (50) boundary and verify the 51st fails.
#[test]
fn security_max_children_boundary() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let content_id = register_default_content(creator);

		// Fund accounts 100-150 with enough balance
		for i in 100u8..=150u8 {
			let _ = Balances::force_set_balance(RuntimeOrigin::root(), account(i).into(), 10_000);
		}

		for i in 100u8..150u8 {
			assert_ok!(ContentRights::subscribe(
				RuntimeOrigin::signed(account(i)),
				content_id,
			));
		}

		assert_noop!(
			ContentRights::subscribe(RuntimeOrigin::signed(account(150u8)), content_id),
			crate::Error::<Test>::MaxChildrenReached
		);
	});
}

/// Set NextContentId to u32::MAX and verify overflow is caught.
#[test]
fn security_content_id_overflow() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		pallet::NextContentId::<Test>::put(u32::MAX);

		assert_noop!(
			ContentRights::register_content(
				RuntimeOrigin::signed(creator),
				[0u8; 32],
				default_title(),
				100, 10, 500, 100,
			),
			crate::Error::<Test>::ContentIdOverflow
		);
	});
}

/// Account with zero balance cannot subscribe.
#[test]
fn security_insufficient_balance_for_subscription() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let broke_user = account(99);
		let content_id = register_default_content(creator);

		assert!(ContentRights::subscribe(
			RuntimeOrigin::signed(broke_user),
			content_id,
		).is_err());
	});
}

/// Purchasing views when a pack already exists overwrites rather than adds.
#[test]
fn security_purchase_views_overwrites_existing_pack() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let buyer = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(buyer.clone()),
			content_id,
			10,
		));
		assert_eq!(pallet::ViewPacks::<Test>::get(content_id, &buyer).unwrap().views_remaining, 10);

		assert_ok!(ContentRights::purchase_views(
			RuntimeOrigin::signed(buyer.clone()),
			content_id,
			5,
		));
		// Overwrites to 5, does NOT add to 15
		assert_eq!(pallet::ViewPacks::<Test>::get(content_id, &buyer).unwrap().views_remaining, 5);
	});
}

/// Cannot purchase ownership twice for the same content.
#[test]
fn security_double_ownership_purchase_rejected() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let buyer = account(2);
		let content_id = register_default_content(creator);

		assert_ok!(ContentRights::purchase_ownership(
			RuntimeOrigin::signed(buyer.clone()),
			content_id,
		));

		assert_noop!(
			ContentRights::purchase_ownership(RuntimeOrigin::signed(buyer), content_id),
			crate::Error::<Test>::AlreadyOwned
		);
	});
}

/// Cannot transfer content you don't own.
#[test]
fn security_transfer_ownership_requires_ownership() {
	new_test_ext().execute_with(|| {
		let creator = account(1);
		let not_owner = account(2);
		let recipient = account(3);
		let content_id = register_default_content(creator);

		assert_noop!(
			ContentRights::transfer_ownership(
				RuntimeOrigin::signed(not_owner),
				content_id,
				recipient,
			),
			crate::Error::<Test>::OwnershipNotFound
		);
	});
}
