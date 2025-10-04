import { useCallback, useMemo } from "react";
import BigNumber from "bignumber.js";
import { RootState } from "@store";
import { useSelector } from "react-redux";
import { dexPricesSelectorByDenomination } from "@waveshq/walletkit-ui/dist/store";

export const SUPPORTED_BASE_DENOMINATIONS = ["USDT", "DUSD"] as const;

interface TokenPrice {
  getTokenPrice: (
    symbol: string,
    amount: BigNumber,
    isLPS?: boolean,
  ) => BigNumber;
}

export function useTokenPrice(denominationTokenSymbol = "USDT"): TokenPrice {
  const blockCount = useSelector((state: RootState) => state.block.count);
  const prices = useSelector((state: RootState) =>
    dexPricesSelectorByDenomination(state.wallet, denominationTokenSymbol),
  );
  const dexPricesByDenomination = useSelector(
    (state: RootState) => state.wallet.dexPrices,
  );
  const pairs = useSelector((state: RootState) => state.wallet.poolpairs);

  const fallbackDexPrices = useMemo(
    () =>
      SUPPORTED_BASE_DENOMINATIONS.filter(
        (denomination) => denomination !== denominationTokenSymbol,
      ).map((denomination) => ({
        denomination,
        prices: dexPricesByDenomination[denomination] ?? {},
      })),
    [dexPricesByDenomination, denominationTokenSymbol],
  );

  const computeConversionRate = useCallback(
    (
      fromSymbol: string,
      toSymbol: string,
      visited: Set<string> = new Set<string>(),
    ): BigNumber | undefined => {
      if (fromSymbol === toSymbol) {
        return new BigNumber(1);
      }

      visited.add(fromSymbol);

      for (const pair of pairs) {
        if (pair.type === "available") {
          const { tokenA, tokenB, priceRatio } = pair.data;

          if (
            priceRatio !== undefined &&
            (tokenA.symbol === fromSymbol || tokenB.symbol === fromSymbol)
          ) {
            const nextSymbol =
              tokenA.symbol === fromSymbol ? tokenB.symbol : tokenA.symbol;

            if (!visited.has(nextSymbol)) {
              const ratio = new BigNumber(
                tokenA.symbol === fromSymbol ? priceRatio.ab : priceRatio.ba,
              );

              if (ratio.isFinite() && !ratio.isZero()) {
                if (nextSymbol === toSymbol) {
                  return ratio;
                }

                const downstreamRate = computeConversionRate(
                  nextSymbol,
                  toSymbol,
                  new Set<string>(visited),
                );

                if (downstreamRate !== undefined) {
                  return ratio.multipliedBy(downstreamRate);
                }
              }
            }
          }
        }
      }

      return undefined;
    },
    [pairs],
  );

  const getFallbackPrice = useCallback(
    (symbol: string, amount: BigNumber): BigNumber | undefined => {
      for (const { denomination, prices: basePrices } of fallbackDexPrices) {
        const basePrice = basePrices[symbol]?.denominationPrice;
        const amountInBase =
          symbol === denomination
            ? amount
            : basePrice !== undefined
              ? new BigNumber(basePrice).multipliedBy(amount)
              : undefined;

        if (amountInBase !== undefined && !amountInBase.isNaN()) {
          if (!amountInBase.isZero()) {
            const conversionRate = computeConversionRate(
              denomination,
              denominationTokenSymbol,
            );

            if (conversionRate !== undefined) {
              return amountInBase.multipliedBy(conversionRate);
            }

            const reverseRate = computeConversionRate(
              denominationTokenSymbol,
              denomination,
            );

            if (reverseRate !== undefined && !reverseRate.isZero()) {
              return amountInBase.dividedBy(reverseRate);
            }
          }
        }
      }

      return undefined;
    },
    [computeConversionRate, fallbackDexPrices, denominationTokenSymbol],
  );

  /**
   * @param symbol {string} token symbol
   * @param amount {string} token amount
   * @param isLPS {boolean} is liquidity pool token
   * @return BigNumber
   */
  const getTokenPrice = useCallback(
    (symbol: string, amount: BigNumber, isLPS: boolean = false): BigNumber => {
      if (
        symbol === denominationTokenSymbol ||
        new BigNumber(amount).isZero()
      ) {
        return new BigNumber(amount);
      }
      if (isLPS) {
        const pair = pairs.find((pair) => pair.data.symbol === symbol);
        if (pair === undefined) {
          return new BigNumber("");
        }
        const ratioToTotal = new BigNumber(amount).div(
          pair.data.totalLiquidity.token,
        );
        const tokenAAmount = ratioToTotal
          .times(pair.data.tokenA.reserve)
          .decimalPlaces(8, BigNumber.ROUND_DOWN);
        const tokenBAmount = ratioToTotal
          .times(pair.data.tokenB.reserve)
          .decimalPlaces(8, BigNumber.ROUND_DOWN);
        const usdTokenA = getTokenPrice(pair.data.tokenA.symbol, tokenAAmount);
        const usdTokenB = getTokenPrice(pair.data.tokenB.symbol, tokenBAmount);
        return usdTokenA.plus(usdTokenB);
      }
      const denominationPrice = prices[symbol]?.denominationPrice;

      if (denominationPrice !== undefined) {
        return new BigNumber(denominationPrice).multipliedBy(amount);
      }

      const fallbackPrice = getFallbackPrice(symbol, amount);

      if (fallbackPrice !== undefined && !fallbackPrice.isNaN()) {
        return fallbackPrice;
      }

      return new BigNumber(0);
    },
    [
      prices,
      pairs,
      blockCount,
      computeConversionRate,
      getFallbackPrice,
      denominationTokenSymbol,
    ],
  );

  return {
    getTokenPrice,
  };
}
