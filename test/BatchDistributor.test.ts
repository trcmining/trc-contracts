import { expect } from "chai";
import { ethers } from "hardhat";

const DEC = 18n;
const unit = (n: bigint) => n * 10n ** DEC;

describe("BatchDistributor", () => {
  const MAX_BATCH = 200n;

  async function setup() {
    const [owner, pool, a, b, c] = await ethers.getSigners();

    const Token = await ethers.getContractFactory("AdvancedERC20");
    const token = await Token.deploy(
      "Data Currency", "DATA", 18, 1_000_000_000n, pool.address,
      0, 0, 0, pool.address, 0n, 0n, 0,
    );
    await token.waitForDeployment();

    const Dist = await ethers.getContractFactory("BatchDistributor");
    const dist = await Dist.deploy(await token.getAddress(), owner.address, MAX_BATCH);
    await dist.waitForDeployment();

    // fund the vault
    await token.connect(pool).transfer(await dist.getAddress(), unit(1_000_000n));
    return { owner, pool, a, b, c, token, dist };
  }

  it("pays out a batch and emits batchId / count / total", async () => {
    const { a, b, c, token, dist } = await setup();
    const to = [a.address, b.address, c.address];
    const amt = [unit(10n), unit(20n), unit(30n)];

    await expect(dist.batchTransfer(42n, to, amt))
      .to.emit(dist, "BatchSent").withArgs(42n, 3n, unit(60n));

    expect(await token.balanceOf(a.address)).to.equal(unit(10n));
    expect(await token.balanceOf(b.address)).to.equal(unit(20n));
    expect(await token.balanceOf(c.address)).to.equal(unit(30n));
    expect(await dist.balance()).to.equal(unit(1_000_000n) - unit(60n));
  });

  it("★ a given batchId can only succeed once (a retry after a timeout cannot pay twice)", async () => {
    const { a, token, dist } = await setup();
    await dist.batchTransfer(7n, [a.address], [unit(100n)]);
    expect(await dist.batchSent(7n)).to.equal(true);

    await expect(
      dist.batchTransfer(7n, [a.address], [unit(100n)]),
    ).to.be.revertedWith("Batch already sent");

    // credited exactly once
    expect(await token.balanceOf(a.address)).to.equal(unit(100n));
  });

  it("★ if any single transfer fails the whole call reverts, leaving no half-succeeded state", async () => {
    const { a, b, token, dist } = await setup();
    const tooMuch = unit(999_999_999n); // far beyond the contract balance

    await expect(
      dist.batchTransfer(1n, [a.address, b.address], [unit(10n), tooMuch]),
    ).to.be.reverted;

    // not even the first transfer should land
    expect(await token.balanceOf(a.address)).to.equal(0n);
    // the batchId is not consumed: after fixing the data it can be retried under the same id
    expect(await dist.batchSent(1n)).to.equal(false);
  });

  it("mismatched array lengths / an empty batch / exceeding the cap are all rejected", async () => {
    const { a, b, dist } = await setup();

    await expect(dist.batchTransfer(1n, [a.address, b.address], [unit(1n)]))
      .to.be.revertedWith("Length mismatch");
    await expect(dist.batchTransfer(2n, [], []))
      .to.be.revertedWith("Empty batch");

    const many = Array(Number(MAX_BATCH) + 1).fill(a.address);
    const amts = Array(Number(MAX_BATCH) + 1).fill(unit(1n));
    await expect(dist.batchTransfer(3n, many, amts))
      .to.be.revertedWith("Batch too large");
  });

  it("a zero address or a zero amount is treated as bad data and rejected", async () => {
    const { a, dist } = await setup();
    await expect(
      dist.batchTransfer(1n, [ethers.ZeroAddress], [unit(1n)]),
    ).to.be.revertedWith("Zero recipient");
    await expect(
      dist.batchTransfer(2n, [a.address], [0n]),
    ).to.be.revertedWith("Zero amount");
  });

  it("only the owner can pay out or withdraw", async () => {
    const { a, dist } = await setup();
    await expect(dist.connect(a).batchTransfer(1n, [a.address], [unit(1n)]))
      .to.be.revertedWithCustomError(dist, "OwnableUnauthorizedAccount");
    await expect(dist.connect(a).withdraw(a.address, unit(1n)))
      .to.be.revertedWithCustomError(dist, "OwnableUnauthorizedAccount");
  });

  it("rescueToken cannot be used to drain the payout token itself", async () => {
    const { owner, token, dist } = await setup();
    await expect(
      dist.rescueToken(await token.getAddress(), owner.address, 1n),
    ).to.be.revertedWith("Use withdraw");
  });

});
