// Mock parachain runtime for XCM integration tests.
// Used by both ParaA (content-rights chain) and ParaB (consumer chain).

use polkadot_sdk::{
	staging_xcm as xcm, staging_xcm_builder as xcm_builder,
	staging_xcm_executor as xcm_executor, *,
};

use frame_support::{
	construct_runtime, derive_impl, parameter_types,
	traits::{AsEnsureOriginWithArg, ConstU32, ConstU64, ConstU128, Everything, Nothing},
	weights::Weight,
};
use frame_system::EnsureRoot;
use sp_runtime::{
	traits::{IdentifyAccount, IdentityLookup, Verify},
	AccountId32, BuildStorage, MultiSignature,
};

use xcm::latest::prelude::*;
use xcm_builder::{
	AccountId32Aliases, AllowTopLevelPaidExecutionFrom, EnsureXcmOrigin,
	FixedRateOfFungible, FixedWeightBounds, FrameTransactionalProcessor,
	FungibleAdapter, IsConcrete, NativeAsset, ParentIsPreset,
	SignedAccountId32AsNative, SignedToAccountId32, SovereignSignedViaLocation,
	TakeWeightCredit,
};
use xcm_executor::XcmExecutor;
use xcm_simulator::mock_message_queue;

pub type AccountId = AccountId32;
pub type Balance = u128;

pub type Signature = MultiSignature;
pub type AccountPublic = <Signature as Verify>::Signer;

parameter_types! {
	pub const BlockHashCount: u64 = 250;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Runtime {
	type AccountId = AccountId;
	type Lookup = IdentityLookup<Self::AccountId>;
	type Block = frame_system::mocking::MockBlock<Runtime>;
	type AccountData = pallet_balances::AccountData<Balance>;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig)]
impl pallet_balances::Config for Runtime {
	type Balance = Balance;
	type AccountStore = System;
}

// Mock message queue from xcm-simulator (handles DMP + XCMP)
impl mock_message_queue::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type XcmExecutor = XcmExecutor<XcmConfig>;
}

// --- pallet-nfts (required by pallet-content-rights) ---

parameter_types! {
	pub storage Features: pallet_nfts::PalletFeatures = pallet_nfts::PalletFeatures::all_enabled();
}

impl pallet_nfts::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type CollectionId = u32;
	type ItemId = u32;
	type Currency = Balances;
	type CreateOrigin = AsEnsureOriginWithArg<frame_system::EnsureSigned<Self::AccountId>>;
	type ForceOrigin = EnsureRoot<Self::AccountId>;
	type Locker = ();
	type CollectionDeposit = ConstU128<2>;
	type ItemDeposit = ConstU128<1>;
	type MetadataDepositBase = ConstU128<1>;
	type AttributeDepositBase = ConstU128<1>;
	type DepositPerByte = ConstU128<1>;
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
	type BlockNumberProvider = frame_system::Pallet<Runtime>;
}

// --- pallet-content-rights ---

parameter_types! {
	pub const MaxChildrenPerNft: u32 = 50;
}

impl pallet_content_rights::Config for Runtime {
	type PaymentCurrency = Balances;
	type MaxChildren = MaxChildrenPerNft;
	type ContentRightsWeightInfo = pallet_content_rights::weights::SubstrateWeight<Runtime>;
}

// --- XCM Configuration ---

parameter_types! {
	pub const KsmLocation: Location = Location::parent();
	pub const RelayNetwork: Option<NetworkId> = None;
	pub UniversalLocation: InteriorLocation = [GlobalConsensus(ByGenesis([0; 32])), Parachain(mock_message_queue::ParachainId::<Runtime>::get().into())].into();
	pub UnitWeightCost: Weight = Weight::from_parts(1_000_000_000, 64 * 1024);
	pub const MaxInstructions: u32 = 100;
	pub const MaxAssetsIntoHolding: u32 = 64;
	// Low rate for testing — 1 token per second, 1 per MB
	pub KsmPerSecondPerByte: (AssetId, u128, u128) =
		(AssetId(KsmLocation::get()), 1, 1);
}

pub type LocationToAccountId = (
	ParentIsPreset<AccountId>,
	xcm_builder::SiblingParachainConvertsVia<
		polkadot_parachain_primitives::primitives::Sibling,
		AccountId,
	>,
	AccountId32Aliases<RelayNetwork, AccountId>,
);

pub type LocalAssetTransactor = FungibleAdapter<
	Balances,
	IsConcrete<KsmLocation>,
	LocationToAccountId,
	AccountId,
	(),
>;

type XcmOriginToCallOrigin = (
	SovereignSignedViaLocation<LocationToAccountId, RuntimeOrigin>,
	SignedAccountId32AsNative<RelayNetwork, RuntimeOrigin>,
);

pub type Barrier = (
	TakeWeightCredit,
	AllowTopLevelPaidExecutionFrom<Everything>,
);

pub struct XcmConfig;
impl xcm_executor::Config for XcmConfig {
	type RuntimeCall = RuntimeCall;
	type XcmSender = XcmRouter;
	type XcmEventEmitter = XcmPallet;
	type AssetTransactor = LocalAssetTransactor;
	type OriginConverter = XcmOriginToCallOrigin;
	type IsReserve = NativeAsset;
	type IsTeleporter = ();
	type UniversalLocation = UniversalLocation;
	type Barrier = Barrier;
	type Weigher = FixedWeightBounds<UnitWeightCost, RuntimeCall, MaxInstructions>;
	type Trader = FixedRateOfFungible<KsmPerSecondPerByte, ()>;
	type ResponseHandler = XcmPallet;
	type AssetTrap = XcmPallet;
	type AssetClaims = XcmPallet;
	type SubscriptionService = XcmPallet;
	type PalletInstancesInfo = AllPalletsWithSystem;
	type MaxAssetsIntoHolding = MaxAssetsIntoHolding;
	type AssetLocker = ();
	type AssetExchanger = ();
	type FeeManager = ();
	type MessageExporter = ();
	type UniversalAliases = Nothing;
	type CallDispatcher = RuntimeCall;
	type SafeCallFilter = Everything;
	type Aliasers = Nothing;
	type TransactionalProcessor = FrameTransactionalProcessor;
	type HrmpNewChannelOpenRequestHandler = ();
	type HrmpChannelAcceptedHandler = ();
	type HrmpChannelClosingHandler = ();
	type XcmRecorder = XcmPallet;
}

pub type LocalOriginToLocation = SignedToAccountId32<RuntimeOrigin, AccountId, RelayNetwork>;

pub type XcmRouter = xcm_builder::EnsureDecodableXcm<crate::ParachainXcmRouter<MsgQueue>>;

impl pallet_xcm::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type SendXcmOrigin = EnsureXcmOrigin<RuntimeOrigin, LocalOriginToLocation>;
	type XcmRouter = XcmRouter;
	type ExecuteXcmOrigin = EnsureXcmOrigin<RuntimeOrigin, LocalOriginToLocation>;
	type XcmExecuteFilter = Everything;
	type XcmExecutor = XcmExecutor<XcmConfig>;
	type XcmTeleportFilter = Nothing;
	type XcmReserveTransferFilter = Everything;
	type Weigher = FixedWeightBounds<UnitWeightCost, RuntimeCall, MaxInstructions>;
	type UniversalLocation = UniversalLocation;
	type RuntimeOrigin = RuntimeOrigin;
	type RuntimeCall = RuntimeCall;
	const VERSION_DISCOVERY_QUEUE_SIZE: u32 = 100;
	type AdvertisedXcmVersion = pallet_xcm::CurrentXcmVersion;
	type Currency = Balances;
	type CurrencyMatcher = ();
	type TrustedLockers = ();
	type SovereignAccountOf = LocationToAccountId;
	type MaxLockers = ConstU32<8>;
	type WeightInfo = pallet_xcm::TestWeightInfo;
	type AdminOrigin = EnsureRoot<AccountId>;
	type MaxRemoteLockConsumers = ConstU32<0>;
	type RemoteLockConsumerIdentifier = ();
	type AuthorizedAliasConsideration = polkadot_sdk::polkadot_sdk_frame::traits::Disabled;
}

construct_runtime! {
	pub enum Runtime {
		System: frame_system,
		Balances: pallet_balances,
		MsgQueue: mock_message_queue,
		XcmPallet: pallet_xcm,
		Nfts: pallet_nfts,
		ContentRights: pallet_content_rights,
	}
}

pub fn new_ext(para_id: u32) -> sp_io::TestExternalities {
	let mut t = frame_system::GenesisConfig::<Runtime>::default()
		.build_storage()
		.unwrap();

	pallet_balances::GenesisConfig::<Runtime> {
		balances: vec![
			(AccountId32::from([1u8; 32]), 1_000_000_000_000),
			(AccountId32::from([2u8; 32]), 1_000_000_000_000),
			(AccountId32::from([3u8; 32]), 1_000_000_000_000),
		],
		dev_accounts: None,
	}
	.assimilate_storage(&mut t)
	.unwrap();

	let mut ext = sp_io::TestExternalities::new(t);
	ext.execute_with(|| {
		System::set_block_number(1);
		MsgQueue::set_para_id(para_id.into());
	});
	ext
}
