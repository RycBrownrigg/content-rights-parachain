//! FRAME benchmarks for `pallet-content-rights` (Finding L).
//!
//! Each benchmark measures the worst case of its extrinsic:
//! - payments: `s` royalty splits (0..=10), each to a new account;
//! - first purchases mint a child NFT (more expensive than repeat purchases);
//! - `check_access` misses ownership, reads an expired subscription and finds a
//!   view pack (all three maps read);
//! - `consume_view`/`consume_view_for` consume the last view (NFT burn);
//! - `enable_auto_renew` searches the full 100-block window for a slot;
//! - `on_initialize_renewals` processes `n` due renewals with `s` splits each,
//!   and every renewal then searches the full window and fails to re-queue.
//!
//! The `scale_*` benchmarks are measurements, not charged weights: they repeat
//! an operation on a content item that already has `h` holders (0..=2,000),
//! to show whether per-operation cost depends on audience size (limitation 4).

use super::*;
use crate::types::*;
use alloc::vec;
use alloc::vec::Vec;
use codec::Encode;
use frame::deps::frame_benchmarking::v2::*;
use frame::prelude::*;
use frame::traits::{fungible::Mutate as _, Currency as _};
use frame_system::RawOrigin;
use polkadot_sdk::pallet_nfts;

const SEED: u32 = 0;
/// Large enough that each of ten 10% royalty shares exceeds any realistic
/// existential deposit (runtime ED is 0.001 UNIT; this is 10 UNIT).
const PRICE: u128 = 10_000_000_000_000;
const MAX_HOLDERS: u32 = 2_000;

fn fund<T: Config>(who: &T::AccountId) {
	let pay = BalanceOf::<T>::max_value() / 100_000u32.into();
	let _ = T::PaymentCurrency::set_balance(who, pay);
	type NftBalance<T> = <<T as pallet_nfts::Config>::Currency as frame::traits::Currency<
		<T as frame_system::Config>::AccountId,
	>>::Balance;
	let deposit = NftBalance::<T>::max_value() / 100_000u32.into();
	<T as pallet_nfts::Config>::Currency::make_free_balance_be(who, deposit);
}

fn funded<T: Config>(name: &'static str, i: u32) -> T::AccountId {
	let who: T::AccountId = account(name, i, SEED);
	fund::<T>(&who);
	who
}

fn caller<T: Config>() -> T::AccountId {
	let who: T::AccountId = whitelisted_caller();
	fund::<T>(&who);
	who
}

fn title() -> BoundedVec<u8, ConstU32<128>> {
	vec![b'x'; 128].try_into().expect("128 bytes fit; qed")
}

/// Register content by a funded creator; returns (content_id, creator).
fn register<T: Config>(period: u32) -> (u32, T::AccountId) {
	let creator = funded::<T>("creator", 0);
	let content_id = NextContentId::<T>::get();
	Pallet::<T>::register_content(
		RawOrigin::Signed(creator.clone()).into(),
		[7u8; 32],
		title(),
		PRICE,
		PRICE,
		PRICE,
		period,
	)
	.expect("register_content succeeds");
	(content_id, creator)
}

fn as_bytes32<T: Config>(who: &T::AccountId) -> [u8; 32] {
	let mut out = [0u8; 32];
	let enc = who.encode();
	let n = enc.len().min(32);
	out[..n].copy_from_slice(&enc[..n]);
	out
}

/// `s` royalty splits of 10% each, to accounts that do not exist yet.
fn set_splits<T: Config>(content_id: u32, s: u32) {
	let splits: Vec<RoyaltySplit> = (0..s)
		.map(|i| RoyaltySplit {
			recipient: as_bytes32::<T>(&account::<T::AccountId>("split", i, SEED)),
			basis_points: 1_000,
		})
		.collect();
	RoyaltySplits::<T>::insert(content_id, BoundedVec::try_from(splits).expect("s <= 10; qed"));
}

fn set_block<T: Config>(n: u32) {
	frame_system::Pallet::<T>::set_block_number(n.into());
}

fn now<T: Config>() -> u32 {
	frame_system::Pallet::<T>::block_number().try_into().unwrap_or(0)
}

/// Fill `RenewalQueue` buckets `from..from + count` with dummy entries.
fn fill_buckets<T: Config>(content_id: u32, from: u32, count: u32) {
	for b in from..from.saturating_add(count) {
		let entries: Vec<(u32, T::AccountId)> = (0..MAX_RENEWALS_PER_BLOCK)
			.map(|i| (content_id, account("filler", b.wrapping_mul(16).wrapping_add(i), SEED)))
			.collect();
		RenewalQueue::<T>::insert(b, BoundedVec::try_from(entries).expect("bucket size; qed"));
	}
}

/// Give `content_id` `h` existing holders of `kind`, minting their child NFTs
/// directly (no payment), as earlier purchases would have.
fn add_holders<T: Config>(content_id: u32, creator: &T::AccountId, h: u32, kind: RightsType) {
	let content = Contents::<T>::get(content_id).expect("registered; qed");
	for i in 0..h {
		let who: T::AccountId = account("holder", i, SEED);
		let child = Pallet::<T>::mint_and_nest_child(
			creator,
			&who,
			content.collection_id,
			content.content_item_id,
			kind.clone(),
		)
		.expect("mint succeeds");
		match kind {
			RightsType::Subscription => Subscriptions::<T>::insert(
				content_id,
				&who,
				SubscriptionInfo { expiry_block: u32::MAX, auto_renew: false, child_item_id: child },
			),
			RightsType::PayPerView => ViewPacks::<T>::insert(
				content_id,
				&who,
				ViewPackInfo { views_remaining: 1, child_item_id: child },
			),
			RightsType::Ownership =>
				Ownership::<T>::insert(content_id, &who, OwnershipInfo { child_item_id: child }),
		}
	}
}

#[benchmarks]
mod benchmarks {
	use super::*;

	#[benchmark]
	fn register_content() {
		let creator = caller::<T>();
		let content_id = NextContentId::<T>::get();
		#[extrinsic_call]
		_(RawOrigin::Signed(creator), [7u8; 32], title(), PRICE, PRICE, PRICE, 100u32);
		assert!(Contents::<T>::contains_key(content_id));
	}

	#[benchmark]
	fn subscribe(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		set_splits::<T>(content_id, s);
		let buyer = caller::<T>();
		#[extrinsic_call]
		_(RawOrigin::Signed(buyer.clone()), content_id);
		assert!(Subscriptions::<T>::contains_key(content_id, &buyer));
	}

	#[benchmark]
	fn renew_subscription(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		let buyer = caller::<T>();
		Pallet::<T>::subscribe(RawOrigin::Signed(buyer.clone()).into(), content_id)
			.expect("subscribe");
		set_splits::<T>(content_id, s);
		let expiry = Subscriptions::<T>::get(content_id, &buyer).unwrap().expiry_block;
		set_block::<T>(expiry);
		#[extrinsic_call]
		_(RawOrigin::Signed(buyer.clone()), content_id);
		assert!(Subscriptions::<T>::get(content_id, &buyer).unwrap().expiry_block > expiry);
	}

	#[benchmark]
	fn purchase_views(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		set_splits::<T>(content_id, s);
		let buyer = caller::<T>();
		#[extrinsic_call]
		_(RawOrigin::Signed(buyer.clone()), content_id, 10u32);
		assert!(ViewPacks::<T>::contains_key(content_id, &buyer));
	}

	#[benchmark]
	fn consume_view() {
		let (content_id, _) = register::<T>(100);
		let viewer = caller::<T>();
		Pallet::<T>::purchase_views(RawOrigin::Signed(viewer.clone()).into(), content_id, 1)
			.expect("purchase");
		#[extrinsic_call]
		_(RawOrigin::Signed(viewer.clone()), content_id);
		assert!(!ViewPacks::<T>::contains_key(content_id, &viewer));
	}

	#[benchmark]
	fn purchase_ownership(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		set_splits::<T>(content_id, s);
		let buyer = caller::<T>();
		#[extrinsic_call]
		_(RawOrigin::Signed(buyer.clone()), content_id);
		assert!(Ownership::<T>::contains_key(content_id, &buyer));
	}

	#[benchmark]
	fn check_access() {
		let (content_id, _) = register::<T>(100);
		let who = caller::<T>();
		Pallet::<T>::subscribe(RawOrigin::Signed(who.clone()).into(), content_id)
			.expect("subscribe");
		Pallet::<T>::purchase_views(RawOrigin::Signed(who.clone()).into(), content_id, 1)
			.expect("purchase");
		let expiry = Subscriptions::<T>::get(content_id, &who).unwrap().expiry_block;
		set_block::<T>(expiry);
		#[extrinsic_call]
		_(RawOrigin::Signed(who.clone()), content_id);
		assert_eq!(Pallet::<T>::access_rights(content_id, &who), Some(RightsType::PayPerView));
	}

	#[benchmark]
	fn xcm_subscribe(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		set_splits::<T>(content_id, s);
		let payer = caller::<T>();
		let beneficiary: T::AccountId = account("beneficiary", 0, SEED);
		#[extrinsic_call]
		_(RawOrigin::Signed(payer), content_id, beneficiary.clone());
		assert!(Subscriptions::<T>::contains_key(content_id, &beneficiary));
	}

	#[benchmark]
	fn xcm_renew_subscription(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		let payer = caller::<T>();
		let beneficiary: T::AccountId = account("beneficiary", 0, SEED);
		Pallet::<T>::xcm_subscribe(
			RawOrigin::Signed(payer.clone()).into(),
			content_id,
			beneficiary.clone(),
		)
		.expect("xcm_subscribe");
		set_splits::<T>(content_id, s);
		let expiry = Subscriptions::<T>::get(content_id, &beneficiary).unwrap().expiry_block;
		set_block::<T>(expiry);
		#[extrinsic_call]
		_(RawOrigin::Signed(payer), content_id, beneficiary.clone());
		assert!(Subscriptions::<T>::get(content_id, &beneficiary).unwrap().expiry_block > expiry);
	}

	#[benchmark]
	fn xcm_purchase_views(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		set_splits::<T>(content_id, s);
		let payer = caller::<T>();
		let beneficiary: T::AccountId = account("beneficiary", 0, SEED);
		#[extrinsic_call]
		_(RawOrigin::Signed(payer), content_id, beneficiary.clone(), 10u32);
		assert!(ViewPacks::<T>::contains_key(content_id, &beneficiary));
	}

	#[benchmark]
	fn xcm_purchase_ownership(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		set_splits::<T>(content_id, s);
		let payer = caller::<T>();
		let beneficiary: T::AccountId = account("beneficiary", 0, SEED);
		#[extrinsic_call]
		_(RawOrigin::Signed(payer), content_id, beneficiary.clone());
		assert!(Ownership::<T>::contains_key(content_id, &beneficiary));
	}

	#[benchmark]
	fn transfer_ownership() {
		let (content_id, _) = register::<T>(100);
		let owner = caller::<T>();
		Pallet::<T>::purchase_ownership(RawOrigin::Signed(owner.clone()).into(), content_id)
			.expect("purchase");
		let to: T::AccountId = account("to", 0, SEED);
		#[extrinsic_call]
		_(RawOrigin::Signed(owner), content_id, to.clone());
		assert!(Ownership::<T>::contains_key(content_id, &to));
	}

	#[benchmark]
	fn xcm_transfer_ownership() {
		let (content_id, _) = register::<T>(100);
		let owner = caller::<T>();
		Pallet::<T>::purchase_ownership(RawOrigin::Signed(owner.clone()).into(), content_id)
			.expect("purchase");
		let to: T::AccountId = account("to", 0, SEED);
		#[extrinsic_call]
		_(RawOrigin::Signed(owner.clone()), content_id, owner.clone(), to.clone());
		assert!(Ownership::<T>::contains_key(content_id, &to));
	}

	#[benchmark]
	fn set_royalty_splits(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, creator) = register::<T>(100);
		let splits: Vec<RoyaltySplit> = (0..s)
			.map(|i| RoyaltySplit {
				recipient: as_bytes32::<T>(&account::<T::AccountId>("split", i, SEED)),
				basis_points: 1_000,
			})
			.collect();
		let splits: BoundedVec<RoyaltySplit, ConstU32<MAX_ROYALTY_SPLITS>> =
			splits.try_into().expect("s <= 10; qed");
		#[extrinsic_call]
		_(RawOrigin::Signed(creator), content_id, splits);
		assert_eq!(RoyaltySplits::<T>::decode_len(content_id).unwrap_or(0) as u32, s);
	}

	#[benchmark]
	fn enable_auto_renew() {
		let period = T::MinAutoRenewPeriod::get().max(1);
		let (content_id, _) = register::<T>(period);
		let who = caller::<T>();
		Pallet::<T>::subscribe(RawOrigin::Signed(who.clone()).into(), content_id)
			.expect("subscribe");
		let expiry = Subscriptions::<T>::get(content_id, &who).unwrap().expiry_block;
		// Worst case: every bucket but the last in the search window is full.
		fill_buckets::<T>(content_id, expiry, MAX_RENEWAL_SLOT_SEARCH - 1);
		#[extrinsic_call]
		_(RawOrigin::Signed(who.clone()), content_id);
		assert!(AutoRenewIndex::<T>::contains_key((content_id, &who)));
	}

	#[benchmark]
	fn disable_auto_renew() {
		let period = T::MinAutoRenewPeriod::get().max(1);
		let (content_id, _) = register::<T>(period);
		let who = caller::<T>();
		Pallet::<T>::subscribe(RawOrigin::Signed(who.clone()).into(), content_id)
			.expect("subscribe");
		Pallet::<T>::enable_auto_renew(RawOrigin::Signed(who.clone()).into(), content_id)
			.expect("enable");
		#[extrinsic_call]
		_(RawOrigin::Signed(who.clone()), content_id);
		assert!(!AutoRenewIndex::<T>::contains_key((content_id, &who)));
	}

	#[benchmark]
	fn query_rights_metadata(s: Linear<0, MAX_ROYALTY_SPLITS>) {
		let (content_id, _) = register::<T>(100);
		set_splits::<T>(content_id, s);
		let who = caller::<T>();
		#[extrinsic_call]
		_(RawOrigin::Signed(who), content_id);
	}

	#[benchmark]
	fn set_meter() {
		let (content_id, creator) = register::<T>(100);
		let meter: T::AccountId = account("meter", 0, SEED);
		#[extrinsic_call]
		_(RawOrigin::Signed(creator), content_id, Some(meter.clone()));
		assert_eq!(Meters::<T>::get(content_id), Some(meter));
	}

	#[benchmark]
	fn consume_view_for() {
		let (content_id, creator) = register::<T>(100);
		let meter = caller::<T>();
		Pallet::<T>::set_meter(RawOrigin::Signed(creator).into(), content_id, Some(meter.clone()))
			.expect("set_meter");
		let viewer = funded::<T>("viewer", 0);
		Pallet::<T>::purchase_views(RawOrigin::Signed(viewer.clone()).into(), content_id, 1)
			.expect("purchase");
		#[extrinsic_call]
		_(RawOrigin::Signed(meter), content_id, viewer.clone());
		assert!(!ViewPacks::<T>::contains_key(content_id, &viewer));
	}

	#[benchmark]
	fn on_initialize_renewals(
		n: Linear<0, MAX_RENEWALS_PER_BLOCK>,
		s: Linear<0, MAX_ROYALTY_SPLITS>,
	) {
		let period = T::MinAutoRenewPeriod::get().max(1);
		let (content_id, _) = register::<T>(period);
		set_splits::<T>(content_id, s);
		let block = now::<T>().saturating_add(1);
		let mut due: Vec<(u32, T::AccountId)> = Vec::new();
		for i in 0..n {
			let who = funded::<T>("renewer", i);
			Pallet::<T>::subscribe(RawOrigin::Signed(who.clone()).into(), content_id)
				.expect("subscribe");
			Subscriptions::<T>::mutate(content_id, &who, |sub| {
				if let Some(sub) = sub {
					sub.expiry_block = block;
					sub.auto_renew = true;
				}
			});
			AutoRenewIndex::<T>::insert((content_id, &who), true);
			due.push((content_id, who));
		}
		RenewalQueue::<T>::insert(block, BoundedVec::try_from(due).expect("n <= 10; qed"));
		// Worst case: every renewal searches the whole window for its next slot.
		fill_buckets::<T>(content_id, block.saturating_add(period), MAX_RENEWAL_SLOT_SEARCH);
		set_block::<T>(block);

		#[block]
		{
			Pallet::<T>::on_initialize(block.into());
		}

		assert!(RenewalQueue::<T>::get(block).is_empty());
	}

	// ---------- Holder-scale measurements (not charged) ----------

	#[benchmark]
	fn scale_subscribe(h: Linear<0, MAX_HOLDERS>) {
		let (content_id, creator) = register::<T>(100);
		add_holders::<T>(content_id, &creator, h, RightsType::Subscription);
		let buyer = caller::<T>();
		#[block]
		{
			Pallet::<T>::subscribe(RawOrigin::Signed(buyer.clone()).into(), content_id)
				.expect("subscribe");
		}
		assert!(Subscriptions::<T>::contains_key(content_id, &buyer));
	}

	#[benchmark]
	fn scale_check_access(h: Linear<0, MAX_HOLDERS>) {
		let (content_id, creator) = register::<T>(100);
		add_holders::<T>(content_id, &creator, h, RightsType::PayPerView);
		let who = caller::<T>();
		Pallet::<T>::purchase_views(RawOrigin::Signed(who.clone()).into(), content_id, 1)
			.expect("purchase");
		#[block]
		{
			Pallet::<T>::check_access(RawOrigin::Signed(who.clone()).into(), content_id)
				.expect("check_access");
		}
	}

	#[benchmark]
	fn scale_consume_view(h: Linear<0, MAX_HOLDERS>) {
		let (content_id, creator) = register::<T>(100);
		add_holders::<T>(content_id, &creator, h, RightsType::PayPerView);
		let viewer = caller::<T>();
		Pallet::<T>::purchase_views(RawOrigin::Signed(viewer.clone()).into(), content_id, 1)
			.expect("purchase");
		#[block]
		{
			Pallet::<T>::consume_view(RawOrigin::Signed(viewer.clone()).into(), content_id)
				.expect("consume_view");
		}
		assert!(!ViewPacks::<T>::contains_key(content_id, &viewer));
	}

	#[benchmark]
	fn scale_transfer_ownership(h: Linear<0, MAX_HOLDERS>) {
		let (content_id, creator) = register::<T>(100);
		add_holders::<T>(content_id, &creator, h, RightsType::Ownership);
		let owner = caller::<T>();
		Pallet::<T>::purchase_ownership(RawOrigin::Signed(owner.clone()).into(), content_id)
			.expect("purchase");
		let to: T::AccountId = account("to", 0, SEED);
		#[block]
		{
			Pallet::<T>::transfer_ownership(
				RawOrigin::Signed(owner.clone()).into(),
				content_id,
				to.clone(),
			)
			.expect("transfer");
		}
		assert!(Ownership::<T>::contains_key(content_id, &to));
	}

	impl_benchmark_test_suite!(Pallet, crate::mock::new_test_ext(), crate::mock::Test);
}
