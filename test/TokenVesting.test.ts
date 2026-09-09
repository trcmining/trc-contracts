import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

/**
 * TokenVesting — the lockup contract for the team allocation.
 *
 * 🔴 **Why these tests were written**: the project decided to lock the team and
 *    advisor allocation (10% of supply, 100,000,000 TRC) into this contract,
 *    and it had **no tests at all**. A contract that holds money does not get
 *    deployed untested.
 *
 * 🔴 **The single most important assertion is `revocable = false`** (the
 *    "irrevocable" group below). It is an argument to `createVestingSchedule`,
 *    not an inherent property of the contract — pass true and the owner can
 *    `revoke` at any time and take back whatever has not vested. Saying publicly
 *    that "the team allocation is locked" would then be a **false statement**,
 *    and one that anyone can disprove on chain. The schedule must be created
 *    with false, and this group is what holds that in place.
 */
const DAY = 24 * 60 * 60;
const MONTH = 30 * DAY;
const DEC = 8n; // same as TRC on mainnet
const unit = (n: bigint) => n * 10n ** DEC;

describe("TokenVesting", () => {
  async function setup() {
    const [owner, team, outsider] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("AdvancedERC20");
    const token = await Token.deploy(
      "Trade Credit", "TRC", 8, 1_000_000_000n, owner.address,
      0, 0, 0, owner.address, 0n, 0n, 0,
    );
    await token.waitForDeployment();

    const V = await ethers.getContractFactory("TokenVesting");
    const vesting = await V.deploy(await token.getAddress());
    await vesting.waitForDeployment();

    // fund the team allocation: 100,000,000 tokens
    await (await token.transfer(await vesting.getAddress(), unit(100_000_000n))).wait();
    return { owner, team, outsider, token, vesting };
  }

  /** Creates a schedule with the parameters the project intends to use: irrevocable, 12-month cliff, 36-month linear */
  async function teamSchedule(vesting: any, beneficiary: string, revocable = false) {
    const start = (await time.latest()) + DAY;
    await vesting.createVestingSchedule(
      beneficiary, start, 12 * MONTH, 36 * MONTH, DAY, revocable, unit(100_000_000n),
    );
    const id = await vesting.computeVestingScheduleIdForAddressAndIndex(beneficiary, 0);
    return { id, start };
  }

  describe("🔴 irrevocable (the configuration the team allocation must use)", () => {
    it("with revocable=false the owner cannot revoke", async () => {
      const { owner, team, vesting } = await setup();
      const { id } = await teamSchedule(vesting, team.address, false);
      await expect(vesting.connect(owner).revoke(id)).to.be.revertedWith("Not revocable");
    });

    it("⚠️ with revocable=true the owner really can take it back — which is why this argument must not be wrong", async () => {
      const { owner, team, vesting } = await setup();
      const { id } = await teamSchedule(vesting, team.address, true);
      await expect(vesting.connect(owner).revoke(id)).to.emit(vesting, "Revoked");
      expect((await vesting.getVestingSchedule(id)).revoked).to.equal(true);
    });

    it("the owner cannot withdraw locked tokens — withdraw only reaches the unallocated part", async () => {
      const { owner, team, vesting, token } = await setup();
      await teamSchedule(vesting, team.address, false);
      // all 100,000,000 are allocated, so the withdrawable balance must be 0
      expect(await vesting.getWithdrawableAmount()).to.equal(0n);
      await expect(vesting.connect(owner).withdraw(1n)).to.be.revertedWith("Not enough withdrawable");
      expect(await token.balanceOf(await vesting.getAddress())).to.equal(unit(100_000_000n));
    });

    it("a schedule larger than the contract balance cannot be created", async () => {
      const { team, vesting } = await setup();
      const start = (await time.latest()) + DAY;
      await expect(
        vesting.createVestingSchedule(team.address, start, 0, MONTH, DAY, false, unit(100_000_001n)),
      ).to.be.revertedWith("Insufficient tokens");
    });
  });

  describe("vesting curve", () => {
    it("nothing is claimable during the cliff", async () => {
      const { team, vesting } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      expect(await vesting.computeReleasableAmount(id)).to.equal(0n);
      // still 0 one second before the cliff
      await time.increaseTo(start + 12 * MONTH - 2);
      expect(await vesting.computeReleasableAmount(id)).to.equal(0n);
    });

    it("⚠️ at the cliff the already-accrued portion becomes claimable — it does not start from 0", async () => {
      const { team, vesting } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      await time.increaseTo(start + 12 * MONTH);
      const releasable = await vesting.computeReleasableAmount(id);
      // 12/36 ≈ 1/3 — a cliff delays when you can claim, not when accrual starts
      expect(releasable).to.be.closeTo(unit(33_333_333n), unit(100_000n));
    });

    it("about half has vested at the midpoint", async () => {
      const { team, vesting } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      await time.increaseTo(start + 18 * MONTH);
      expect(await vesting.computeReleasableAmount(id)).to.be.closeTo(unit(50_000_000n), unit(100_000n));
    });

    it("everything has vested at the end, and never more than the total", async () => {
      const { team, vesting } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      await time.increaseTo(start + 36 * MONTH);
      expect(await vesting.computeReleasableAmount(id)).to.equal(unit(100_000_000n));
      // waiting another year does not increase it
      await time.increaseTo(start + 48 * MONTH);
      expect(await vesting.computeReleasableAmount(id)).to.equal(unit(100_000_000n));
    });
  });

  describe("claiming", () => {
    it("a claim by the beneficiary credits their balance and reduces the releasable amount", async () => {
      const { team, vesting, token } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      await time.increaseTo(start + 18 * MONTH);
      const before = await vesting.computeReleasableAmount(id);
      await vesting.connect(team).release(id, unit(10_000_000n));
      expect(await token.balanceOf(team.address)).to.equal(unit(10_000_000n));
      expect(await vesting.computeReleasableAmount(id)).to.be.closeTo(before - unit(10_000_000n), unit(10_000n));
    });

    it("⚠️ the owner can trigger a release too, but the tokens only go to the beneficiary — the recipient cannot be changed", async () => {
      const { owner, team, vesting, token } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      await time.increaseTo(start + 36 * MONTH);
      await vesting.connect(owner).release(id, unit(1_000_000n));
      expect(await token.balanceOf(team.address)).to.equal(unit(1_000_000n));
      expect(await token.balanceOf(owner.address)).to.equal(unit(900_000_000n)); // only what was never transferred in
    });

    it("an unrelated address cannot claim", async () => {
      const { outsider, team, vesting } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      await time.increaseTo(start + 36 * MONTH);
      await expect(vesting.connect(outsider).release(id, 1n)).to.be.revertedWith("Not authorized");
    });

    it("cannot claim more than has vested", async () => {
      const { team, vesting } = await setup();
      const { id, start } = await teamSchedule(vesting, team.address);
      await time.increaseTo(start + 18 * MONTH);
      await expect(vesting.connect(team).release(id, unit(90_000_000n)))
        .to.be.revertedWith("Not enough vested tokens");
    });

    it("a non-existent schedule cannot be claimed", async () => {
      const { team, vesting } = await setup();
      const fake = ethers.keccak256(ethers.toUtf8Bytes("nope"));
      await expect(vesting.connect(team).release(fake, 1n)).to.be.revertedWith("Schedule not found");
    });
  });

  describe("only the owner can create schedules or withdraw", () => {
    it("a non-owner cannot create a schedule", async () => {
      const { outsider, team, vesting } = await setup();
      const start = (await time.latest()) + DAY;
      await expect(
        vesting.connect(outsider).createVestingSchedule(team.address, start, 0, MONTH, DAY, false, 1n),
      ).to.be.revertedWithCustomError(vesting, "OwnableUnauthorizedAccount");
    });

    it("the owner can withdraw the unallocated part", async () => {
      const { owner, team, vesting, token } = await setup();
      const start = (await time.latest()) + DAY;
      await vesting.createVestingSchedule(team.address, start, 0, MONTH, DAY, false, unit(60_000_000n));
      expect(await vesting.getWithdrawableAmount()).to.equal(unit(40_000_000n));
      await vesting.connect(owner).withdraw(unit(40_000_000n));
      expect(await vesting.getWithdrawableAmount()).to.equal(0n);
    });
  });

  /**
   * 🔴 **The exact parameters used for the team allocation on mainnet.**
   *
   * The decision was worded as "12-month cliff plus 36-month linear vesting",
   * and that sentence has two possible implementations **33,330,000 tokens apart**:
   *
   *   A (the contract's native semantics)  start=today, cliffDuration=12mo, duration=36mo
   *     → 12/36 ≈ 33,330,000 claimable on the cliff date itself; fully vested at month 36.
   *   B (what was chosen)                  start=+12mo, cliffDuration=0, duration=36mo
   *     → **0** claimable on the cliff date; accrual only begins then; fully vested at month **48**.
   *
   * Why B: when you tell people there is a "12-month lockup", B is what most of
   * them understand. Under A, a third of the allocation is sellable the moment
   * the lockup ends, which does not match the impression "locked for a year" gives.
   *
   * ⚠️ State the cost plainly: **under B full vesting lands in month 48, not month 36.**
   */
  describe("🔴 the team allocation's actual parameters (semantics B: the first 12 months do not count at all)", () => {
    const START_DELAY = 365 * DAY;      // start pushed out by 12 months
    const CLIFF_DURATION = 0;           // under B the cliff is start itself
    const DURATION = 36 * MONTH;        // 36 months linear
    const SLICE = MONTH;                // one release step per month
    const TOTAL = unit(100_000_000n);   // team and advisors, 10% of supply

    async function teamSetup() {
      const ctx = await setup();
      const start = (await time.latest()) + START_DELAY;
      await ctx.vesting.createVestingSchedule(
        ctx.team.address, start, CLIFF_DURATION, DURATION, SLICE, false, TOTAL,
      );
      const id = await ctx.vesting.computeVestingScheduleIdForAddressAndIndex(ctx.team.address, 0);
      return { ...ctx, start, id };
    }

    it("month 11: zero", async () => {
      const { vesting, id, start } = await teamSetup();
      await time.increaseTo(start - 30 * DAY);
      expect(await vesting.computeReleasableAmount(id)).to.equal(0n);
    });

    it("🔴 exactly month 12 (the cliff date): still zero — this is the entire point of choosing B", async () => {
      const { vesting, id, start } = await teamSetup();
      await time.increaseTo(start);
      expect(await vesting.computeReleasableAmount(id)).to.equal(0n);
    });

    it("⚠️ configured as A, the same date would unlock about 33,330,000 — the difference, measured", async () => {
      const { vesting, team, token } = await setup();
      const now = await time.latest();
      // A: start=now, cliffDuration=12 months, duration=36 months
      await vesting.createVestingSchedule(team.address, now + 1, 365 * DAY, DURATION, SLICE, false, TOTAL);
      const id = await vesting.computeVestingScheduleIdForAddressAndIndex(team.address, 0);
      await time.increaseTo(now + 1 + 365 * DAY);
      const vested = await vesting.computeReleasableAmount(id);
      // 365 days / 1080 days ≈ 33.8%, rounded down to whole months ≈ 33,330,000
      expect(vested).to.be.closeTo(unit(33_330_000n), unit(400_000n));
      expect(await token.balanceOf(team.address)).to.equal(0n); // not claimed yet, but claimable
    });

    it("month 30 (18 months after start): about half vested", async () => {
      const { vesting, id, start } = await teamSetup();
      await time.increaseTo(start + 18 * MONTH);
      expect(await vesting.computeReleasableAmount(id)).to.be.closeTo(TOTAL / 2n, unit(100_000n));
    });

    it("month 48: all 100,000,000 vested, and not one token more", async () => {
      const { vesting, id, start } = await teamSetup();
      await time.increaseTo(start + DURATION);
      expect(await vesting.computeReleasableAmount(id)).to.equal(TOTAL);
    });

    it("🔴 revocable must be false — only then is the owner unable to revoke, and only then is \u0027locked\u0027 a true statement", async () => {
      const { vesting, owner, id } = await teamSetup();
      await expect(vesting.connect(owner).revoke(id)).to.be.revertedWith("Not revocable");
    });

    it("🔴 during the lockup the owner cannot withdraw a single token", async () => {
      const { vesting, owner, start } = await teamSetup();
      await time.increaseTo(start + 6 * MONTH);
      expect(await vesting.getWithdrawableAmount()).to.equal(0n);
      await expect(vesting.connect(owner).withdraw(1n)).to.be.revertedWith("Not enough withdrawable");
    });

    it("the beneficiary is fixed in the schedule; the owner cannot change the recipient", async () => {
      const { vesting, owner, team, outsider, token, id, start } = await teamSetup();
      await time.increaseTo(start + 18 * MONTH);
      const amount = unit(1_000_000n);
      // the owner can trigger a release, but the tokens only go to the beneficiary
      await vesting.connect(owner).release(id, amount);
      expect(await token.balanceOf(team.address)).to.equal(amount);
      expect(await token.balanceOf(outsider.address)).to.equal(0n);
      // no function in the contract can change the beneficiary
      expect((await vesting.getVestingSchedule(id)).beneficiary).to.equal(team.address);
    });
  });

  describe("✅ revoke ledger fix (the amount used to be under-counted)", () => {
    /**
     * **The defect**: `release()` decrements `vestingSchedulesTotalAmount -= amount`
     * when it transfers, but the transfer inside `revoke()` that first pays the
     * already-vested portion to the beneficiary **omitted that same decrement**.
     * The subsequent single decrement only covers `amountTotal - released`, so the
     * vestedAmount that had just been paid out was still counted in totalAmount.
     * `getWithdrawableAmount() = balance - totalAmount` therefore under-reported by
     * that amount, and that part of the balance was stuck in the contract forever —
     * not even the owner could get it out.
     *
     * The direction was **conservative** (the owner could withdraw less, never more),
     * and the team allocation uses `revocable=false` so it never reaches this path —
     * but a contract holding 100,000,000 tokens should not go to mainnet carrying a
     * broken ledger, so it was fixed.
     *
     * ⚠️ What was fixed is the **accounting**, not the permissions: a schedule with
     *    `revocable=false` still cannot be revoked (see the group above).
     */
    it("after a revoke, withdrawable = contract balance (the vested part is no longer under-counted)", async () => {
      const { owner, team, vesting, token } = await setup();
      const start = (await time.latest()) + DAY;
      await vesting.createVestingSchedule(team.address, start, 0, 10 * DAY, DAY, true, unit(10_000_000n));
      await time.increaseTo(start + 5 * DAY); // half vested
      await vesting.connect(owner).revoke(await vesting.computeVestingScheduleIdForAddressAndIndex(team.address, 0));

      const vested = await token.balanceOf(team.address); // paid to the beneficiary at revoke time
      expect(vested).to.be.closeTo(unit(5_000_000n), unit(50_000n));

      const balance = await token.balanceOf(await vesting.getAddress());
      // this schedule is void and no other schedule holds anything ⇒ the whole remaining balance must be withdrawable
      expect(await vesting.getWithdrawableAmount()).to.equal(balance);
    });

    it("after a revoke the owner can withdraw the entire remainder — before the fix this call reverted", async () => {
      const { owner, team, vesting, token } = await setup();
      const start = (await time.latest()) + DAY;
      await vesting.createVestingSchedule(team.address, start, 0, 10 * DAY, DAY, true, unit(10_000_000n));
      await time.increaseTo(start + 5 * DAY);
      await vesting.connect(owner).revoke(await vesting.computeVestingScheduleIdForAddressAndIndex(team.address, 0));

      const balance = await token.balanceOf(await vesting.getAddress());
      await expect(vesting.connect(owner).withdraw(balance)).to.not.be.reverted;
      expect(await token.balanceOf(await vesting.getAddress())).to.equal(0n);
    });

    it("a revoke does not affect other schedules: the second one stays fully locked", async () => {
      const { owner, team, outsider, vesting, token } = await setup();
      const start = (await time.latest()) + DAY;
      await vesting.createVestingSchedule(team.address, start, 0, 10 * DAY, DAY, true, unit(10_000_000n));
      await vesting.createVestingSchedule(outsider.address, start, 0, 10 * DAY, DAY, false, unit(20_000_000n));
      await time.increaseTo(start + 5 * DAY);
      await vesting.connect(owner).revoke(await vesting.computeVestingScheduleIdForAddressAndIndex(team.address, 0));

      const balance = await token.balanceOf(await vesting.getAddress());
      // the second schedule still holds 20,000,000, which must stay excluded from the withdrawable amount
      expect(await vesting.getWithdrawableAmount()).to.equal(balance - unit(20_000_000n));
      await expect(vesting.connect(owner).withdraw(balance)).to.be.revertedWith("Not enough withdrawable");
    });
  });
});
