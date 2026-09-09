import { expect } from "chai";
import { ethers } from "hardhat";

/**
 * Dry run of the exact mainnet parameters for TRC.
 *
 * Deploys once with the same constructor arguments used on mainnet and asserts
 * that the resulting contract is what the specification describes. Mainnet
 * cannot be rolled back, and name / symbol / supply / decimals are fixed at
 * creation, so these assertions were the last check before going live.
 */
describe("TRC (Trade Credit) mainnet parameters", () => {
  const NAME = "Trade Credit";
  const SYMBOL = "TRC";
  const DECIMALS = 8;
  const TOTAL_SUPPLY = 1_000_000_000n;
  const MAX_TX = 100_000n;
  const MAX_WALLET = 1_000_000_000n;
  const TRADING_DELAY = 0;

  async function deploy(recipient: string, taxes = { buy: 0n, sell: 0n, liq: 0n }) {
    const factory = await ethers.getContractFactory("AdvancedERC20");
    const token = await factory.deploy(
      NAME, SYMBOL, DECIMALS, TOTAL_SUPPLY, recipient,
      taxes.buy, taxes.sell, taxes.liq, recipient,
      MAX_TX, MAX_WALLET, TRADING_DELAY,
    );
    await token.waitForDeployment();
    return token;
  }

  it("basic metadata matches the specification", async () => {
    const [, recipient] = await ethers.getSigners();
    const token = await deploy(recipient.address);

    expect(await token.name()).to.equal(NAME);
    expect(await token.symbol()).to.equal(SYMBOL);
    expect(await token.decimals()).to.equal(DECIMALS);
    expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY * 10n ** BigInt(DECIMALS));
  });

  it("the entire supply lands on the recipient address", async () => {
    const [deployer, recipient] = await ethers.getSigners();
    const token = await deploy(recipient.address);

    expect(await token.balanceOf(recipient.address)).to.equal(
      TOTAL_SUPPLY * 10n ** BigInt(DECIMALS),
    );
    expect(await token.balanceOf(deployer.address)).to.equal(0n);
  });

  it("anti-bot parameters are given in whole tokens and scaled to base units", async () => {
    const [, recipient] = await ethers.getSigners();
    const token = await deploy(recipient.address);

    expect(await token.maxTxAmount()).to.equal(MAX_TX * 10n ** BigInt(DECIMALS));
    // the wallet cap is set to the total supply, i.e. no cap at all
    expect(await token.maxWalletAmount()).to.equal(await token.totalSupply());
    expect(await token.tradingDelay()).to.equal(TRADING_DELAY);
  });

  it("taxes are zero at deployment, and the owner can still switch them on later", async () => {
    const [deployer, recipient] = await ethers.getSigners();
    const token = await deploy(recipient.address);

    expect(await token.buyTax()).to.equal(0n);
    expect(await token.sellTax()).to.equal(0n);

    // The client wanted trading taxes but had not settled on a rate; this
    // confirms they can still be set after deployment.
    await token.connect(deployer).setTaxes(300n, 300n, 200n);
    expect(await token.buyTax()).to.equal(300n);
    expect(await token.liquidityTax()).to.equal(200n);
  });

  it("the owner starts as the deployment wallet and moves to the recipient after transfer", async () => {
    const [deployer, recipient] = await ethers.getSigners();
    const token = await deploy(recipient.address);

    // This is exactly why a transferOwnership step is needed: the constructor
    // only sends the tokens to the recipient, it does not hand over ownership.
    expect(await token.owner()).to.equal(deployer.address);

    await token.connect(deployer).transferOwnership(recipient.address);
    expect(await token.owner()).to.equal(recipient.address);

    // after the transfer the deployment wallet can no longer call admin functions
    await expect(
      token.connect(deployer).setDexPair(recipient.address, true),
    ).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
  });

  it("with no DEX pair registered, ordinary transfers are neither capped nor taxed", async () => {
    const [, recipient, alice] = await ethers.getSigners();
    const token = await deploy(recipient.address, { buy: 500n, sell: 500n, liq: 0n });

    // the per-transaction cap is 100,000 tokens and this moves 500,000:
    // wallet-to-wallet transfers must not be blocked
    const amount = 500_000n * 10n ** BigInt(DECIMALS);
    await token.connect(recipient).transfer(alice.address, amount);

    // taxes apply to DEX trades only, so alice receives the full amount
    expect(await token.balanceOf(alice.address)).to.equal(amount);
  });

  it("the per-transaction cap only takes effect once a DEX pair is registered", async () => {
    const [deployer, recipient, pair] = await ethers.getSigners();
    const token = await deploy(recipient.address);

    await token.connect(deployer).setDexPair(pair.address, true);

    // the recipient is exempted from limits by the constructor, so test with a plain address
    const [, , , alice] = await ethers.getSigners();
    await token.connect(recipient).transfer(alice.address, 500_000n * 10n ** BigInt(DECIMALS));

    const overLimit = 200_000n * 10n ** BigInt(DECIMALS); // above the 100,000 cap
    await expect(
      token.connect(alice).transfer(pair.address, overLimit),
    ).to.be.revertedWith("Exceeds max tx");
  });
});
