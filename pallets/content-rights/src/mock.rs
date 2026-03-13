use frame::{
	deps::{
		frame_support::{
			construct_runtime, derive_impl, parameter_types,
			traits::{AsEnsureOriginWithArg, ConstU32, ConstU64},
		},
		frame_system,
		sp_io,
		sp_runtime::{
			traits::{IdentifyAccount, IdentityLookup, Verify},
			BuildStorage, MultiSignature,
		},
	},
	prelude::*,
};
use polkadot_sdk::{pallet_balances, pallet_nfts};

type Block = frame_system::mocking::MockBlock<Test>;

construct_runtime!(
	pub enum Test
	{
		System: frame_system,
		Balances: pallet_balances,
		Nfts: pallet_nfts,
		ContentRights: crate,
	}
);

pub type Signature = MultiSignature;
pub type AccountPublic = <Signature as Verify>::Signer;
pub type AccountId = <AccountPublic as IdentifyAccount>::AccountId;

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type AccountId = AccountId;
	type Lookup = IdentityLookup<Self::AccountId>;
	type Block = Block;
	type AccountData = pallet_balances::AccountData<u64>;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig)]
impl pallet_balances::Config for Test {
	type AccountStore = System;
}

parameter_types! {
	pub storage Features: pallet_nfts::PalletFeatures = pallet_nfts::PalletFeatures::all_enabled();
}

impl pallet_nfts::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type CollectionId = u32;
	type ItemId = u32;
	type Currency = Balances;
	type CreateOrigin = AsEnsureOriginWithArg<frame_system::EnsureSigned<Self::AccountId>>;
	type ForceOrigin = frame_system::EnsureRoot<Self::AccountId>;
	type Locker = ();
	type CollectionDeposit = ConstU64<2>;
	type ItemDeposit = ConstU64<1>;
	type MetadataDepositBase = ConstU64<1>;
	type AttributeDepositBase = ConstU64<1>;
	type DepositPerByte = ConstU64<1>;
	type StringLimit = ConstU32<50>;
	type KeyLimit = ConstU32<50>;
	type ValueLimit = ConstU32<50>;
	type ApprovalsLimit = ConstU32<10>;
	type ItemAttributesApprovalsLimit = ConstU32<2>;
	type MaxTips = ConstU32<10>;
	type MaxDeadlineDuration = ConstU64<10000>;
	type MaxAttributesPerCall = ConstU32<2>;
	type Features = Features;
	type OffchainSignature = Signature;
	type OffchainPublic = AccountPublic;
	type WeightInfo = ();
	#[cfg(feature = "runtime-benchmarks")]
	type Helper = ();
	type BlockNumberProvider = frame_system::Pallet<Test>;
}

parameter_types! {
	pub const MaxChildrenPerNft: u32 = 50;
}

impl crate::Config for Test {
	type PaymentCurrency = Balances;
	type MaxChildren = MaxChildrenPerNft;
	type ContentRightsWeightInfo = crate::weights::SubstrateWeight<Test>;
}

/// Helper to create an AccountId from a u8 seed.
pub fn account(id: u8) -> AccountId {
	use frame::deps::sp_core::{sr25519, Pair};
	let pair = sr25519::Pair::from_seed(&[id; 32]);
	let public = pair.public();
	frame::deps::sp_runtime::MultiSigner::Sr25519(public).into_account()
}

pub fn new_test_ext() -> sp_io::TestExternalities {
	let mut t = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();

	let creator = account(1);
	let user_a = account(2);
	let user_b = account(3);

	pallet_balances::GenesisConfig::<Test> {
		balances: vec![
			(creator, 10_000),
			(user_a, 10_000),
			(user_b, 10_000),
		],
		dev_accounts: None,
	}
	.assimilate_storage(&mut t)
	.unwrap();

	let mut ext = sp_io::TestExternalities::new(t);
	ext.execute_with(|| System::set_block_number(1));
	ext
}
