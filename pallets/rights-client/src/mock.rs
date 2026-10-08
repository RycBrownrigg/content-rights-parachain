//! Mock runtime for `pallet-rights-client` unit tests and benchmarks. XCM is
//! routed to a recording sender instead of another chain.

use crate as pallet_rights_client;
use core::cell::RefCell;
use frame::deps::{
	frame_support::{
		construct_runtime, derive_impl, parameter_types,
		traits::{ConstU32, Everything, Nothing},
		weights::Weight,
		PalletId,
	},
	frame_system::{self, EnsureRoot},
	sp_io,
	sp_runtime::{AccountId32, BuildStorage},
};
use polkadot_sdk::{
	pallet_balances, pallet_xcm, staging_xcm as xcm, staging_xcm_builder as xcm_builder,
	staging_xcm_executor as xcm_executor,
};
use xcm::latest::prelude::*;
use xcm_builder::{
	AccountId32Aliases, AllowTopLevelPaidExecutionFrom, EnsureXcmOrigin, FixedRateOfFungible,
	FixedWeightBounds, FrameTransactionalProcessor, FungibleAdapter, IsConcrete, NativeAsset,
	ParentIsPreset, SignedAccountId32AsNative, SignedToAccountId32, SovereignSignedViaLocation,
	TakeWeightCredit,
};

pub type AccountId = AccountId32;
pub type Balance = u128;
type Block = frame_system::mocking::MockBlock<Test>;

construct_runtime!(
	pub enum Test {
		System: frame_system,
		Balances: pallet_balances,
		XcmPallet: pallet_xcm,
		RightsClient: pallet_rights_client,
	}
);

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
	type AccountId = AccountId;
	type Lookup = frame::deps::sp_runtime::traits::IdentityLookup<AccountId>;
	type Block = Block;
	type AccountData = pallet_balances::AccountData<Balance>;
}

#[derive_impl(pallet_balances::config_preludes::TestDefaultConfig)]
impl pallet_balances::Config for Test {
	type Balance = Balance;
	type AccountStore = System;
}

thread_local! {
	/// Messages "sent" by the pallet: (destination, message).
	pub static SENT: RefCell<Vec<(Location, Xcm<()>)>> = RefCell::new(Vec::new());
}

/// Records every message instead of delivering it.
pub struct RecordingRouter;
impl SendXcm for RecordingRouter {
	type Ticket = (Location, Xcm<()>);
	fn validate(
		dest: &mut Option<Location>,
		msg: &mut Option<Xcm<()>>,
	) -> SendResult<Self::Ticket> {
		Ok(((dest.take().unwrap(), msg.take().unwrap()), Assets::new()))
	}
	fn deliver(ticket: Self::Ticket) -> Result<XcmHash, SendError> {
		let hash = ticket.1.using_encoded(frame::deps::sp_io::hashing::blake2_256);
		SENT.with(|s| s.borrow_mut().push(ticket));
		Ok(hash)
	}
}
use codec::Encode as _;

parameter_types! {
	pub const RelayLocation: Location = Location::parent();
	pub const RelayNetwork: Option<NetworkId> = None;
	pub UniversalLocation: InteriorLocation = [GlobalConsensus(ByGenesis([0; 32])), Parachain(200)].into();
	pub UnitWeightCost: Weight = Weight::from_parts(1_000_000_000, 64 * 1024);
	pub const MaxInstructions: u32 = 100;
	pub const MaxAssetsIntoHolding: u32 = 64;
	pub FeeRate: (AssetId, u128, u128) = (AssetId(RelayLocation::get()), 1, 1);
}

pub type LocationToAccountId =
	(ParentIsPreset<AccountId>, AccountId32Aliases<RelayNetwork, AccountId>);

pub struct XcmConfig;
impl xcm_executor::Config for XcmConfig {
	type RuntimeCall = RuntimeCall;
	type XcmSender = RecordingRouter;
	type XcmEventEmitter = XcmPallet;
	type AssetTransactor =
		FungibleAdapter<Balances, IsConcrete<RelayLocation>, LocationToAccountId, AccountId, ()>;
	type OriginConverter = (
		SovereignSignedViaLocation<LocationToAccountId, RuntimeOrigin>,
		SignedAccountId32AsNative<RelayNetwork, RuntimeOrigin>,
	);
	type IsReserve = NativeAsset;
	type IsTeleporter = ();
	type UniversalLocation = UniversalLocation;
	type Barrier = (TakeWeightCredit, AllowTopLevelPaidExecutionFrom<Everything>);
	type Weigher = FixedWeightBounds<UnitWeightCost, RuntimeCall, MaxInstructions>;
	type Trader = FixedRateOfFungible<FeeRate, ()>;
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

impl pallet_xcm::Config for Test {
	type RuntimeEvent = RuntimeEvent;
	type SendXcmOrigin = EnsureXcmOrigin<RuntimeOrigin, LocalOriginToLocation>;
	type XcmRouter = RecordingRouter;
	type ExecuteXcmOrigin = EnsureXcmOrigin<RuntimeOrigin, LocalOriginToLocation>;
	type XcmExecuteFilter = Nothing;
	type XcmExecutor = xcm_executor::XcmExecutor<XcmConfig>;
	type XcmTeleportFilter = Nothing;
	type XcmReserveTransferFilter = Nothing;
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
	type AuthorizedAliasConsideration = frame::traits::Disabled;
}

parameter_types! {
	pub RightsChain: Location = Location::new(1, [Parachain(100)]);
	pub SelfLocation: Location = Location::new(1, [Parachain(200)]);
	pub ExecutionFee: Asset = (Parent, 150_000u128).into();
	pub const RightsPalletIndex: u8 = 51;
	pub const QueryTimeout: u64 = 100;
	pub const Operator: AccountId = AccountId32::new([0xEE; 32]);
	pub const ClientPalletId: PalletId = PalletId(*b"ccrms/cl");
}

#[cfg(feature = "runtime-benchmarks")]
pub struct BenchHelper;
#[cfg(feature = "runtime-benchmarks")]
impl crate::BenchmarkHelper<RuntimeOrigin> for BenchHelper {
	fn prepare_delivery() {}
	fn response_origin(responder: Location) -> RuntimeOrigin {
		pallet_xcm::Origin::Response(responder).into()
	}
}

impl pallet_rights_client::Config for Test {
	type NotifyCall = RuntimeCall;
	type ResponseOrigin = pallet_xcm::EnsureResponse<Everything>;
	type EscrowCurrency = Balances;
	type RightsChain = RightsChain;
	type RightsPalletIndex = RightsPalletIndex;
	type SelfLocation = SelfLocation;
	type ExecutionFee = ExecutionFee;
	type QueryTimeout = QueryTimeout;
	type Operator = Operator;
	type PalletId = ClientPalletId;
	type ClientWeightInfo = crate::weights::SubstrateWeight<Test>;
	#[cfg(feature = "runtime-benchmarks")]
	type BenchmarkHelper = BenchHelper;
}

pub const USER: AccountId = AccountId32::new([0xC1; 32]);

pub fn new_test_ext() -> sp_io::TestExternalities {
	let mut t = frame_system::GenesisConfig::<Test>::default().build_storage().unwrap();
	pallet_balances::GenesisConfig::<Test> { balances: vec![(USER, 1_000_000)], dev_accounts: None }
		.assimilate_storage(&mut t)
		.unwrap();
	let mut ext = sp_io::TestExternalities::new(t);
	ext.execute_with(|| {
		System::set_block_number(1);
		SENT.with(|s| s.borrow_mut().clear());
	});
	ext
}
