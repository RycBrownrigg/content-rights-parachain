// XCM integration tests for cross-chain content rights management.
//
// Uses xcm-simulator to test full message routing between a mock relay chain
// and two parachains:
//   - ParaA (para 100): content-rights chain (registers content, manages rights)
//   - ParaB (para 200): consumer chain (sends XCM Transact to subscribe/purchase)

pub mod parachain;
pub mod relay_chain;

use polkadot_sdk::{
	staging_xcm as xcm, staging_xcm_builder as xcm_builder,
	staging_xcm_executor as xcm_executor, *,
};
use xcm::latest::prelude::*;
use xcm_simulator::{decl_test_network, TestExt};

use sp_runtime::{traits::AccountIdConversion, AccountId32};

// Declare the mock relay chain
xcm_simulator::decl_test_relay_chain! {
	pub struct Relay {
		Runtime = relay_chain::Runtime,
		RuntimeCall = relay_chain::RuntimeCall,
		RuntimeEvent = relay_chain::RuntimeEvent,
		XcmConfig = relay_chain::XcmConfig,
		MessageQueue = relay_chain::MessageQueue,
		System = relay_chain::System,
		new_ext = relay_chain::new_ext(),
	}
}

// ParaA: content-rights parachain (para ID 100)
xcm_simulator::decl_test_parachain! {
	pub struct ParaA {
		Runtime = parachain::Runtime,
		XcmpMessageHandler = parachain::MsgQueue,
		DmpMessageHandler = parachain::MsgQueue,
		new_ext = parachain::new_ext(100),
	}
}

// ParaB: consumer parachain (para ID 200)
xcm_simulator::decl_test_parachain! {
	pub struct ParaB {
		Runtime = parachain::Runtime,
		XcmpMessageHandler = parachain::MsgQueue,
		DmpMessageHandler = parachain::MsgQueue,
		new_ext = parachain::new_ext(200),
	}
}

decl_test_network! {
	pub struct MockNet {
		relay_chain = Relay,
		parachains = vec![
			(100, ParaA),
			(200, ParaB),
		],
	}
}

// --- Test helpers ---

const CREATOR: AccountId32 = AccountId32::new([1u8; 32]);
const BENEFICIARY: AccountId32 = AccountId32::new([2u8; 32]);

fn default_title() -> frame_support::BoundedVec<u8, frame_support::traits::ConstU32<128>> {
	b"Test Content".to_vec().try_into().unwrap()
}

/// Register content on ParaA and return the content_id.
fn register_content_on_para_a() -> u32 {
	ParaA::execute_with(|| {
		let content_id = pallet_content_rights::NextContentId::<parachain::Runtime>::get();
		frame_support::assert_ok!(
			pallet_content_rights::Pallet::<parachain::Runtime>::register_content(
				parachain::RuntimeOrigin::signed(CREATOR),
				[0u8; 32],        // metadata_hash
				default_title(),
				1_000,             // subscription_price
				100,               // ppv_price
				5_000,             // ownership_price
				100,               // period_length (blocks)
			)
		);
		content_id
	})
}

/// Get the sovereign account of a parachain on another chain.
fn sovereign_account_of(para_id: u32) -> AccountId32 {
	// Sovereign accounts for sibling parachains use Sibling prefix.
	polkadot_parachain_primitives::primitives::Sibling::from(para_id).into_account_truncating()
}

/// Fund a sovereign account on ParaA so it can pay for rights.
fn fund_sovereign_on_para_a(para_id: u32, amount: u128) {
	let sovereign = sovereign_account_of(para_id);
	ParaA::execute_with(|| {
		frame_support::assert_ok!(
			pallet_balances::Pallet::<parachain::Runtime>::force_set_balance(
				parachain::RuntimeOrigin::root(),
				sovereign.into(),
				amount,
			)
		);
	});
}

#[cfg(test)]
mod tests {
	use super::*;
	use codec::Encode;
	use frame_support::assert_ok;
	use xcm_simulator::TestExt;

	/// Test 1: Verify that XCM Transact from a sibling parachain
	/// correctly dispatches xcm_subscribe on the content-rights chain.
	#[test]
	fn xcm_transact_subscribe_from_sibling() {
		MockNet::reset();

		// Step 1: Register content on ParaA
		let content_id = register_content_on_para_a();

		// Step 2: Fund ParaB's sovereign account on ParaA
		fund_sovereign_on_para_a(200, 100_000);

		// Step 3: From ParaB, send XCM Transact to ParaA with xcm_subscribe
		ParaB::execute_with(|| {
			let call = parachain::RuntimeCall::ContentRights(
				pallet_content_rights::Call::xcm_subscribe {
					content_id,
					beneficiary: BENEFICIARY,
				},
			);

			assert_ok!(parachain::XcmPallet::send_xcm(
				Here,
				(Parent, Parachain(100)),
				Xcm(vec![
					WithdrawAsset((Parent, 50_000u128).into()),
					BuyExecution {
						fees: (Parent, 50_000u128).into(),
						weight_limit: Unlimited,
					},
					Transact {
						origin_kind: OriginKind::SovereignAccount,
						call: call.encode().into(),
						fallback_max_weight: None,
					},
				]),
			));
		});

		// Step 4: Verify subscription was created on ParaA for the beneficiary
		ParaA::execute_with(|| {
			let sub = pallet_content_rights::Subscriptions::<parachain::Runtime>::get(
				content_id,
				&BENEFICIARY,
			);
			assert!(sub.is_some(), "Beneficiary should have a subscription");

			let sub = sub.unwrap();
			assert_eq!(sub.expiry_block, 1 + 100); // block 1 + period 100

			// Verify the sovereign account does NOT have a subscription
			let sovereign = sovereign_account_of(200);
			let sovereign_sub = pallet_content_rights::Subscriptions::<parachain::Runtime>::get(
				content_id,
				&sovereign,
			);
			assert!(sovereign_sub.is_none(), "Sovereign account should NOT have a subscription");
		});
	}

	/// Test 2: Cross-chain ownership purchase via XCM Transact.
	#[test]
	fn xcm_transact_purchase_ownership_from_sibling() {
		MockNet::reset();

		let content_id = register_content_on_para_a();
		fund_sovereign_on_para_a(200, 100_000);

		ParaB::execute_with(|| {
			let call = parachain::RuntimeCall::ContentRights(
				pallet_content_rights::Call::xcm_purchase_ownership {
					content_id,
					beneficiary: BENEFICIARY,
				},
			);

			assert_ok!(parachain::XcmPallet::send_xcm(
				Here,
				(Parent, Parachain(100)),
				Xcm(vec![
					WithdrawAsset((Parent, 50_000u128).into()),
					BuyExecution {
						fees: (Parent, 50_000u128).into(),
						weight_limit: Unlimited,
					},
					Transact {
						origin_kind: OriginKind::SovereignAccount,
						call: call.encode().into(),
						fallback_max_weight: None,
					},
				]),
			));
		});

		ParaA::execute_with(|| {
			assert!(
				pallet_content_rights::Ownership::<parachain::Runtime>::get(
					content_id,
					&BENEFICIARY,
				),
				"Beneficiary should own the content"
			);

			let sovereign = sovereign_account_of(200);
			assert!(
				!pallet_content_rights::Ownership::<parachain::Runtime>::get(
					content_id,
					&sovereign,
				),
				"Sovereign account should NOT own the content"
			);
		});
	}

	/// Test 3: Cross-chain view pack purchase via XCM Transact.
	#[test]
	fn xcm_transact_purchase_views_from_sibling() {
		MockNet::reset();

		let content_id = register_content_on_para_a();
		fund_sovereign_on_para_a(200, 100_000);

		ParaB::execute_with(|| {
			let call = parachain::RuntimeCall::ContentRights(
				pallet_content_rights::Call::xcm_purchase_views {
					content_id,
					beneficiary: BENEFICIARY,
					num_views: 5,
				},
			);

			assert_ok!(parachain::XcmPallet::send_xcm(
				Here,
				(Parent, Parachain(100)),
				Xcm(vec![
					WithdrawAsset((Parent, 50_000u128).into()),
					BuyExecution {
						fees: (Parent, 50_000u128).into(),
						weight_limit: Unlimited,
					},
					Transact {
						origin_kind: OriginKind::SovereignAccount,
						call: call.encode().into(),
						fallback_max_weight: None,
					},
				]),
			));
		});

		ParaA::execute_with(|| {
			let pack = pallet_content_rights::ViewPacks::<parachain::Runtime>::get(
				content_id,
				&BENEFICIARY,
			);
			assert!(pack.is_some(), "Beneficiary should have a view pack");
			assert_eq!(pack.unwrap().views_remaining, 5);
		});
	}

	/// Test 4: Cross-chain subscription renewal via XCM Transact.
	#[test]
	fn xcm_transact_renew_subscription_from_sibling() {
		MockNet::reset();

		let content_id = register_content_on_para_a();
		fund_sovereign_on_para_a(200, 200_000);

		// First subscribe
		ParaB::execute_with(|| {
			let call = parachain::RuntimeCall::ContentRights(
				pallet_content_rights::Call::xcm_subscribe {
					content_id,
					beneficiary: BENEFICIARY,
				},
			);

			assert_ok!(parachain::XcmPallet::send_xcm(
				Here,
				(Parent, Parachain(100)),
				Xcm(vec![
					WithdrawAsset((Parent, 50_000u128).into()),
					BuyExecution {
						fees: (Parent, 50_000u128).into(),
						weight_limit: Unlimited,
					},
					Transact {
						origin_kind: OriginKind::SovereignAccount,
						call: call.encode().into(),
						fallback_max_weight: None,
					},
				]),
			));
		});

		// Advance past expiry on ParaA
		ParaA::execute_with(|| {
			frame_system::Pallet::<parachain::Runtime>::set_block_number(101);
		});

		// Now renew
		ParaB::execute_with(|| {
			let call = parachain::RuntimeCall::ContentRights(
				pallet_content_rights::Call::xcm_renew_subscription {
					content_id,
					beneficiary: BENEFICIARY,
				},
			);

			assert_ok!(parachain::XcmPallet::send_xcm(
				Here,
				(Parent, Parachain(100)),
				Xcm(vec![
					WithdrawAsset((Parent, 50_000u128).into()),
					BuyExecution {
						fees: (Parent, 50_000u128).into(),
						weight_limit: Unlimited,
					},
					Transact {
						origin_kind: OriginKind::SovereignAccount,
						call: call.encode().into(),
						fallback_max_weight: None,
					},
				]),
			));
		});

		ParaA::execute_with(|| {
			let sub = pallet_content_rights::Subscriptions::<parachain::Runtime>::get(
				content_id,
				&BENEFICIARY,
			);
			assert!(sub.is_some(), "Subscription should still exist");
			assert_eq!(sub.unwrap().expiry_block, 101 + 100, "Expiry should be renewed from block 101");
		});
	}

	/// Test 5: XCM Transact fails if content doesn't exist.
	#[test]
	fn xcm_transact_subscribe_nonexistent_content() {
		MockNet::reset();
		fund_sovereign_on_para_a(200, 100_000);

		ParaB::execute_with(|| {
			let call = parachain::RuntimeCall::ContentRights(
				pallet_content_rights::Call::xcm_subscribe {
					content_id: 999, // doesn't exist
					beneficiary: BENEFICIARY,
				},
			);

			assert_ok!(parachain::XcmPallet::send_xcm(
				Here,
				(Parent, Parachain(100)),
				Xcm(vec![
					WithdrawAsset((Parent, 50_000u128).into()),
					BuyExecution {
						fees: (Parent, 50_000u128).into(),
						weight_limit: Unlimited,
					},
					Transact {
						origin_kind: OriginKind::SovereignAccount,
						call: call.encode().into(),
						fallback_max_weight: None,
					},
				]),
			));
		});

		// Subscription should NOT exist
		ParaA::execute_with(|| {
			assert!(
				pallet_content_rights::Subscriptions::<parachain::Runtime>::get(
					999,
					&BENEFICIARY,
				)
				.is_none(),
				"No subscription should be created for non-existent content"
			);
		});
	}

	/// Test 6: Verify that the relay chain can also send Transact to the parachain.
	#[test]
	fn relay_transact_to_parachain() {
		MockNet::reset();

		let content_id = register_content_on_para_a();

		// Fund relay's sovereign account on ParaA
		// ParentIsPreset derives the account from b"Parent" with trailing zeros
		ParaA::execute_with(|| {
			use codec::Decode;
			let relay_sovereign = AccountId32::decode(
				&mut sp_runtime::traits::TrailingZeroInput::new(b"Parent"),
			)
			.expect("infinite input; qed");
			frame_support::assert_ok!(
				pallet_balances::Pallet::<parachain::Runtime>::force_set_balance(
					parachain::RuntimeOrigin::root(),
					relay_sovereign,
					100_000,
				)
			);
		});

		// Send Transact from relay to ParaA (with paid execution)
		Relay::execute_with(|| {
			let call = parachain::RuntimeCall::ContentRights(
				pallet_content_rights::Call::xcm_subscribe {
					content_id,
					beneficiary: BENEFICIARY,
				},
			);

			assert_ok!(relay_chain::XcmPallet::send_xcm(
				Here,
				Parachain(100),
				Xcm(vec![
					WithdrawAsset((Parent, 50_000u128).into()),
					BuyExecution {
						fees: (Parent, 50_000u128).into(),
						weight_limit: Unlimited,
					},
					Transact {
						origin_kind: OriginKind::SovereignAccount,
						call: call.encode().into(),
						fallback_max_weight: None,
					},
				]),
			));
		});

		ParaA::execute_with(|| {
			let sub = pallet_content_rights::Subscriptions::<parachain::Runtime>::get(
				content_id,
				&BENEFICIARY,
			);
			assert!(sub.is_some(), "Beneficiary should have a subscription from relay Transact");
		});
	}
}
