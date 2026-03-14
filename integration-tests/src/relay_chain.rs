// Mock relay chain runtime for XCM integration tests.

use polkadot_sdk::{
	staging_xcm as xcm, staging_xcm_builder as xcm_builder,
	staging_xcm_executor as xcm_executor, *,
};

use frame_support::{
	construct_runtime, derive_impl, parameter_types,
	traits::{ConstU32, Contains, Everything, Nothing, ProcessMessage, ProcessMessageError},
	weights::{Weight, WeightMeter},
};
use frame_system::EnsureRoot;
use sp_runtime::{traits::IdentityLookup, AccountId32, BuildStorage};

use xcm::latest::prelude::*;
use xcm_builder::{
	AccountId32Aliases, AllowTopLevelPaidExecutionFrom, ChildParachainAsNative,
	ChildParachainConvertsVia, ChildSystemParachainAsSuperuser, FixedRateOfFungible,
	FixedWeightBounds, FrameTransactionalProcessor, FungibleAdapter, IsConcrete,
	SignedAccountId32AsNative, SignedToAccountId32, SovereignSignedViaLocation,
	TakeWeightCredit,
};
use xcm_executor::XcmExecutor;

pub type AccountId = AccountId32;
pub type Balance = u128;

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

// Message processor for UMP (upward messages from parachains)
pub struct MessageProcessor;
impl ProcessMessage for MessageProcessor {
	type Origin = polkadot_runtime_parachains::inclusion::AggregateMessageOrigin;

	fn process_message(
		message: &[u8],
		origin: Self::Origin,
		meter: &mut WeightMeter,
		id: &mut [u8; 32],
	) -> Result<bool, ProcessMessageError> {
		let para = match origin {
			polkadot_runtime_parachains::inclusion::AggregateMessageOrigin::Ump(
				polkadot_runtime_parachains::inclusion::UmpQueueId::Para(para),
			) => para,
		};
		xcm_builder::ProcessXcmMessage::<
			Junction,
			XcmExecutor<XcmConfig>,
			RuntimeCall,
		>::process_message(message, Junction::Parachain(para.into()), meter, id)
	}
}

parameter_types! {
	pub MessageQueueServiceWeight: Weight = Weight::from_parts(1_000_000_000, 1_000_000);
	pub const MessageQueueMaxStale: u32 = 8;
	pub const MessageQueueHeapSize: u32 = 64 * 1024;
}

impl pallet_message_queue::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type MessageProcessor = MessageProcessor;
	type Size = u32;
	type QueueChangeHandler = ();
	type QueuePausedQuery = ();
	type HeapSize = MessageQueueHeapSize;
	type MaxStale = MessageQueueMaxStale;
	type ServiceWeight = MessageQueueServiceWeight;
	type IdleMaxServiceWeight = ();
	type WeightInfo = ();
}

// --- XCM Configuration ---

parameter_types! {
	pub const TokenLocation: Location = Here.into_location();
	pub RelayNetwork: NetworkId = ByGenesis([0; 32]);
	pub UniversalLocation: InteriorLocation = RelayNetwork::get().into();
	pub UnitWeightCost: Weight = Weight::from_parts(1_000_000_000, 64 * 1024);
	pub const MaxInstructions: u32 = 100;
	pub const MaxAssetsIntoHolding: u32 = 64;
	pub TokensPerSecondPerByte: (AssetId, u128, u128) =
		(AssetId(TokenLocation::get()), 1_000_000_000_000, 1024 * 1024);
}

pub type SovereignAccountOf = (
	ChildParachainConvertsVia<polkadot_parachain_primitives::primitives::Sibling, AccountId>,
	AccountId32Aliases<RelayNetwork, AccountId>,
);

pub type LocalAssetTransactor = FungibleAdapter<
	Balances,
	IsConcrete<TokenLocation>,
	SovereignAccountOf,
	AccountId,
	(),
>;

type LocalOriginConverter = (
	SovereignSignedViaLocation<SovereignAccountOf, RuntimeOrigin>,
	SignedAccountId32AsNative<RelayNetwork, RuntimeOrigin>,
	ChildSystemParachainAsSuperuser<polkadot_parachain_primitives::primitives::Id, RuntimeOrigin>,
);

pub struct ParentOrSiblings;
impl Contains<Location> for ParentOrSiblings {
	fn contains(location: &Location) -> bool {
		matches!(location.unpack(), (0, [Parachain(_)]))
	}
}

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
	type OriginConverter = LocalOriginConverter;
	type IsReserve = ();
	type IsTeleporter = ();
	type UniversalLocation = UniversalLocation;
	type Barrier = Barrier;
	type Weigher = FixedWeightBounds<UnitWeightCost, RuntimeCall, MaxInstructions>;
	type Trader = FixedRateOfFungible<TokensPerSecondPerByte, ()>;
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

pub type XcmRouter = xcm_builder::EnsureDecodableXcm<crate::RelayChainXcmRouter>;

impl pallet_xcm::Config for Runtime {
	type RuntimeEvent = RuntimeEvent;
	type SendXcmOrigin =
		xcm_builder::EnsureXcmOrigin<RuntimeOrigin, LocalOriginToLocation>;
	type XcmRouter = XcmRouter;
	type ExecuteXcmOrigin =
		xcm_builder::EnsureXcmOrigin<RuntimeOrigin, LocalOriginToLocation>;
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
	type SovereignAccountOf = SovereignAccountOf;
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
		MessageQueue: pallet_message_queue,
		XcmPallet: pallet_xcm,
	}
}

pub fn new_ext() -> sp_io::TestExternalities {
	let mut t = frame_system::GenesisConfig::<Runtime>::default()
		.build_storage()
		.unwrap();

	pallet_balances::GenesisConfig::<Runtime> {
		balances: vec![
			(AccountId32::from([1u8; 32]), 1_000_000_000_000),
			(AccountId32::from([2u8; 32]), 1_000_000_000_000),
		],
		dev_accounts: None,
	}
	.assimilate_storage(&mut t)
	.unwrap();

	let mut ext = sp_io::TestExternalities::new(t);
	ext.execute_with(|| System::set_block_number(1));
	ext
}
