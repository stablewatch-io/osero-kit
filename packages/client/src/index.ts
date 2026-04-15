// ABIs -----------------------------------------------------------------
export { erc20Abi, erc4626Abi, litePsmAbi, psm3Abi, usdsPsmWrapperAbi } from './lib/abis/index.js';

// Adapters (shared helpers) --------------------------------------------
export {
  flattenExecutionPlan,
  isErc20ApprovalRequired,
  isMultiStepExecution,
  isTransactionRequest,
} from './lib/adapters.js';

// Addresses -------------------------------------------------------------
export { PSM_ADDRESSES, type PsmAddresses } from './lib/addresses.js';

// Balances --------------------------------------------------------------
export {
  getSUsdsBalance,
  getTokenBalance,
  getTokenBalances,
  getUsdcBalance,
  getUsdsBalance,
  type GetBalancesRequest,
  type GetTokenBalanceError,
  type GetTokenBalanceRequest,
  type TokenBalances,
} from './lib/balances.js';

// Chain registry --------------------------------------------------------
export {
  CHAINS,
  type ChainMetadata,
  getChain,
  isSupportedChainId,
  listChains,
  type OseroChainId,
  SUPPORTED_CHAIN_IDS,
} from './lib/chains.js';

// Client config ---------------------------------------------------------
export type { ClientConfig, ResolvedClientConfig } from './lib/config.js';

// Errors ----------------------------------------------------------------
export {
  CancelError,
  InsufficientBalanceError,
  OseroError,
  SigningError,
  TransactionError,
  UnexpectedError,
  UnsupportedChainError,
  ValidationError,
} from './lib/errors.js';

// Math helpers ----------------------------------------------------------
export {
  applySlippage,
  BPS,
  usdcFromUsdsViaBuyGem,
  usdsFromUsdcViaSellGem,
  USDC_TO_USDS_SCALE,
  usdsNeededForUsdcViaBuyGem,
  WAD,
} from './lib/math.js';

// Client class ----------------------------------------------------------
export { OseroClient, type OseroPublicClient } from './lib/OseroClient.js';

// Plan construction helpers --------------------------------------------
export {
  makeApprovalRequiredPlan,
  makeApprovalTransaction,
  makeMultiStepPlan,
  makeSingleApprovalPlan,
  makeTransactionRequest,
} from './lib/plan.js';

// Result type re-exports ------------------------------------------------
export {
  err,
  errAsync,
  fromAsyncThrowable,
  fromPromise,
  fromThrowable,
  ok,
  okAsync,
  Result,
  ResultAsync,
} from './lib/result.js';

// Tokens ----------------------------------------------------------------
export { getToken, listTokens, type Token, type TokenSymbol } from './lib/tokens.js';

// Core types ------------------------------------------------------------
export type {
  ActionError,
  Erc20Approval,
  Erc20ApprovalRequired,
  ExecutionPlan,
  ExecutionPlanHandler,
  ExecutionStep,
  MultiStepExecution,
  OperationType,
  SendWithError,
  TransactionRequest,
  TransactionResult,
} from './lib/types.js';
