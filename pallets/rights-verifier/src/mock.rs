//! Mock runtime for rights-verifier pallet tests.

use frame::{
	deps::{
		frame_support::{construct_runtime, derive_impl},
		frame_system,
		sp_io,
		sp_runtime::BuildStorage,
	},
};
use polkadot_sdk::pallet_balances;

type Block = frame_system::mocking::MockBlock<Test>;

construct_runtime!(
	pub enum Test
	{
		System: frame_system,
		Balances: pallet_balances,
		RightsVerifier: crate,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type Block = Block;
	type AccountData = pallet_balances::AccountData<u64>;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig)]
impl pallet_balances::Config for Test {
	type AccountStore = System;
}

impl crate::Config for Test {
	type VerifierWeightInfo = crate::SubstrateWeight<Test>;
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	let mut t = frame_system::GenesisConfig::<Test>::default()
		.build_storage()
		.unwrap();

	pallet_balances::GenesisConfig::<Test> {
		balances: vec![(1, 10_000), (2, 10_000), (3, 10_000)],
		dev_accounts: None,
	}
	.assimilate_storage(&mut t)
	.unwrap();

	let mut ext = sp_io::TestExternalities::new(t);
	ext.execute_with(|| System::set_block_number(1));
	ext
}
