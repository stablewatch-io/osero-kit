import type { Address } from 'viem';

import { erc20Abi } from './abis/erc20.js';
import { getChain } from './chains.js';
import { UnexpectedError, UnsupportedChainError } from './errors.js';
import type { OseroClient } from './OseroClient.js';
import { ResultAsync, errAsync } from './result.js';
import { getToken, type TokenSymbol } from './tokens.js';

export type GetTokenBalanceRequest = {
  readonly chainId: number;
  readonly account: Address;
  readonly token: TokenSymbol;
};

export type GetBalancesRequest = {
  readonly chainId: number;
  readonly account: Address;
};

export type TokenBalances = {
  readonly USDC: bigint;
  readonly USDS: bigint;
  readonly sUSDS: bigint;
};

export type GetTokenBalanceError = UnsupportedChainError | UnexpectedError;

/**
 * Read a wallet's balance for one canonical Osero token on a supported chain.
 */
export function getTokenBalance(
  client: OseroClient,
  request: GetTokenBalanceRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  const chain = getChain(request.chainId);
  if (!chain) {
    return errAsync(new UnsupportedChainError(request.chainId));
  }

  const token = getToken(chain.chainId, request.token);
  const publicClient = client.getPublicClient(chain.chainId);

  return ResultAsync.fromPromise(
    publicClient.readContract({
      address: token.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [request.account],
    }),
    (err) => UnexpectedError.from(err),
  );
}

/**
 * Read USDC, USDS, and sUSDS balances together for a wallet.
 */
export function getTokenBalances(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<TokenBalances, GetTokenBalanceError> {
  return ResultAsync.combine([
    getTokenBalance(client, { ...request, token: 'USDC' }),
    getTokenBalance(client, { ...request, token: 'USDS' }),
    getTokenBalance(client, { ...request, token: 'sUSDS' }),
  ]).map(([USDC, USDS, sUSDS]) => ({ USDC, USDS, sUSDS }));
}

export function getUsdcBalance(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  return getTokenBalance(client, { ...request, token: 'USDC' });
}

export function getUsdsBalance(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  return getTokenBalance(client, { ...request, token: 'USDS' });
}

export function getSUsdsBalance(
  client: OseroClient,
  request: GetBalancesRequest,
): ResultAsync<bigint, GetTokenBalanceError> {
  return getTokenBalance(client, { ...request, token: 'sUSDS' });
}
