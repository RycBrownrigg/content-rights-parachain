//! Unit tests for `pallet-rights-client` (the two-chain behaviour is tested in
//! the xcm-simulator suite, `integration-tests`).

use crate::{mock::*, Pending, RightsRequest};
use frame::deps::frame_support::{assert_noop, assert_ok};
use polkadot_sdk::{pallet_xcm, staging_xcm::latest::prelude::*};

/// The request takes the escrow, registers a query and sends the complete
/// program (refund appendix, Transact, status report) to the rights chain.
#[test]
fn request_sends_complete_program_and_holds_escrow() {
	new_test_ext().execute_with(|| {
		assert_ok!(RightsClient::request(
			RuntimeOrigin::signed(USER),
			RightsRequest::PurchaseViews { content_id: 7, num_views: 3 },
			1_000,
		));
		assert_eq!(Balances::free_balance(USER), 1_000_000 - 1_000);
		assert_eq!(Balances::free_balance(RightsClient::escrow_account()), 1_000);
		let (query_id, pending) = Pending::<Test>::iter().next().expect("one pending request");

		let (dest, msg) = SENT.with(|s| s.borrow()[0].clone());
		assert_eq!(dest, RightsChain::get());
		let instrs = msg.0;
		assert!(matches!(instrs[0], WithdrawAsset(_)));
		assert!(matches!(instrs[1], BuyExecution { .. }));
		assert!(matches!(&instrs[2], SetAppendix(a) if matches!(a.0[..], [RefundSurplus, DepositAsset { .. }])));
		match &instrs[3] {
			Transact { origin_kind: OriginKind::SovereignAccount, call, .. } => {
				let bytes = call.clone().into_encoded();
				assert_eq!(&bytes[..2], &[51u8, 9u8]); // ContentRights.xcm_purchase_views
			},
			other => panic!("expected Transact, got {other:?}"),
		}
		assert!(matches!(&instrs[4], ReportTransactStatus(info) if info.query_id == query_id));
		assert_eq!(pending.who, USER);
	});
}

#[test]
fn failure_report_refunds_and_success_pays_operator() {
	new_test_ext().execute_with(|| {
		let response = |loc: Location| -> RuntimeOrigin { pallet_xcm::Origin::Response(loc).into() };
		for request in [RightsRequest::Subscribe { content_id: 1 }, RightsRequest::Subscribe { content_id: 2 }] {
			assert_ok!(RightsClient::request(RuntimeOrigin::signed(USER), request, 1_000));
		}
		let ids: Vec<u64> = {
			let mut v: Vec<u64> = Pending::<Test>::iter_keys().collect();
			v.sort();
			v
		};
		assert_ok!(RightsClient::on_outcome(
			response(RightsChain::get()),
			ids[0],
			Response::DispatchResult(MaybeErrorCode::Error(Default::default())),
		));
		assert_eq!(Balances::free_balance(USER), 1_000_000 - 1_000);
		assert_ok!(RightsClient::on_outcome(
			response(RightsChain::get()),
			ids[1],
			Response::DispatchResult(MaybeErrorCode::Success),
		));
		assert_eq!(Balances::free_balance(Operator::get()), 1_000);
		assert!(Pending::<Test>::iter().next().is_none());

		// A settled query cannot be settled again.
		assert_noop!(
			RightsClient::on_outcome(
				response(RightsChain::get()),
				ids[1],
				Response::DispatchResult(MaybeErrorCode::Success),
			),
			crate::Error::<Test>::UnknownQuery
		);
	});
}
