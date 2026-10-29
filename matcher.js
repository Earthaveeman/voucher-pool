'use strict';

/**
 * 全新智能匹配算法（与旧版贪心无任何逻辑关联）。
 *
 * 建模：带次级目标的子集和（subset-sum）问题，动态规划求全局最优组合。
 *   评分字典序（越小越优）：
 *     1. |组合合计 - 目标|（分）   —— 精确凑齐优先
 *     2. 是否达成目标（合计 ≥ 目标） —— 差额打平时"凑够"优先于"差一点"
 *     3. 组合张数                    —— 越少越优
 *     4. 开票年月序之和              —— 越早越优（优先消化池中的老票）
 *
 * 实现要点：
 *   - DP 状态轴为「可达合计金额（分）」，上限取 target + 池中单张最大分值：
 *     超额超过一张最大票的组合，去掉任意一张后差额与张数同时变小，必被支配，
 *     故最优解不会越过该上限（总池不足时上限自然收敛到池总额）。
 *   - 每个状态以"位掩码快照"记录组合明细：更新时复制来源状态的掩码再置位，
 *     掩码在写入时即为不可变快照，回溯读最终掩码即可，不存在原地 DP 的链路失真问题。
 *   - 金额一律换算为整数「分」参与运算，规避二进制浮点误差。
 *
 * 性能护栏（opts 可覆盖）：
 *   - maxCount：组合张数上限（与一次领取上限对齐，避免推荐出无法领取的组合）
 *   - poolCap：候选池截断上限（按金额从小到大保留，小额票对精确凑齐贡献更大）
 *   - stateCap：DP 状态数上限（防止超大金额票据撑爆状态轴）
 *   - budget：内层比较总次数预算（防止 极端 池 × 状态 组合拖垮响应）
 *   - 被状态轴裁掉的超大票据单独按"单张成组"参与最终比较，不漏解
 */

const DEFAULT_OPTS = {
  maxCount: 10,
  poolCap: 300,
  stateCap: 250000,
  budget: 50e6,
};

/**
 * 在候选票据池中搜索最优组合。
 *
 * @param {Array<{id:number, cents:number, monthOrd:number}>} pool 候选池（已按类型过滤、状态 available）
 *        cents：票据金额（分，正整数）；monthOrd：开票年月序（YYYY*12+月序，越大越晚）
 * @param {number} targetCents 目标金额（分，正整数）
 * @param {object} [opts] 性能护栏 { maxCount, poolCap, stateCap, budget }
 * @returns {{picked:Array<number>, sumCents:number, count:number,
 *            exact:boolean, gapCents:number}|null}
 *          picked 为入选票据 id 列表；gapCents = sumCents - targetCents（正=多出，负=还差）；
 *          候选池为空或无可用组合时返回 null。
 */
function findBestMatch(pool, targetCents, opts) {
  const o = { ...DEFAULT_OPTS, ...opts };
  if (!Number.isInteger(targetCents) || targetCents <= 0 || !Array.isArray(pool)) return null;

  // 候选规整：过滤非法项
  const items = [];
  for (const it of pool) {
    if (it && Number.isInteger(it.id) && Number.isInteger(it.cents) && it.cents > 0
      && Number.isInteger(it.monthOrd) && it.monthOrd >= 0) {
      items.push({ id: it.id, cents: it.cents, mo: it.monthOrd });
    }
  }
  if (items.length === 0) return null;

  const totalCents = items.reduce((s, i) => s + i.cents, 0);
  const maxSingle = items.reduce((m, i) => Math.max(m, i.cents), 0);

  // 状态轴上限：目标 + 单张最大（覆盖最优超额组合），且不超过池总额与护栏
  const cap = Math.min(targetCents + maxSingle, totalCents, o.stateCap);

  // 金额从小到大排序后截断：小额票对精确凑齐贡献更大，截断损失最小
  items.sort((a, b) => a.cents - b.cents || a.mo - b.mo || a.id - b.id);
  const budgetN = Math.max(1, Math.floor(o.budget / (cap + 1)));
  const kept = items.filter((i) => i.cents <= cap).slice(0, Math.min(o.poolCap, budgetN));

  // 超出状态轴的票据（仅 stateCap 生效时会出现）：单张成组参与最终比较，不漏解
  const oversized = items.filter((i) => i.cents > cap);

  // ---- DP：dp[s] = 合计恰为 s 的最优 (张数, 年月序和) 组合，掩码记录成员 ----
  const n = kept.length;
  if (n > 0) {
    const size = cap + 1;
    const words = (n + 31) >> 5; // 每个状态一个 n 位的成员位掩码
    const cnt = new Int32Array(size).fill(-1); // -1 = 不可达
    const mon = new Int32Array(size); // 年月序之和
    const mask = new Uint32Array(size * words);
    cnt[0] = 0; // 空组合

    for (let i = 0; i < n; i++) {
      const c = kept[i].cents;
      const mo = kept[i].mo;
      const bit = 1 << (i & 31);
      const wIdx = i >> 5;
      // 金额降序遍历：保证每张票据在单趟内至多被使用一次（0/1 语义）
      for (let s = cap; s >= c; s--) {
        const t = s - c;
        if (cnt[t] < 0) continue;
        const nc = cnt[t] + 1;
        if (nc > o.maxCount) continue;
        const nm = mon[t] + mo;
        if (cnt[s] < 0 || nc < cnt[s] || (nc === cnt[s] && nm < mon[s])) {
          cnt[s] = nc;
          mon[s] = nm;
          // 复制来源状态掩码快照并置本位：写入即不可变，回溯无链路失真
          const dst = s * words;
          const src = t * words;
          for (let w = 0; w < words; w++) mask[dst + w] = mask[src + w];
          mask[dst + wIdx] |= bit;
        }
      }
    }

    // ---- 在全部可达状态中按评分字典序选优 ----
    // key: (|s-target|, s<target, cnt, mon) —— 差额最小 → 凑够优先 → 张数最少 → 年月较早
    let bestS = -1;
    for (let s = 0; s <= cap; s++) {
      if (cnt[s] < 0 || s === 0) continue; // 空组合不作为推荐结果
      if (bestS < 0) { bestS = s; continue; }
      if (betterThan(s, cnt[s], mon[s], bestS, cnt[bestS], mon[bestS], targetCents)) bestS = s;
    }

    // 超大票据单张成组参与比较
    let bestBig = null;
    for (const it of oversized) {
      if (bestBig === null || betterThan(it.cents, 1, it.mo, bestBig.cents, 1, bestBig.mo, targetCents)) {
        bestBig = it;
      }
    }

    if (bestBig && (bestS < 0 || betterThan(bestBig.cents, 1, bestBig.mo, bestS, cnt[bestS], mon[bestS], targetCents))) {
      return finish([bestBig], targetCents);
    }
    if (bestS < 0) return null; // 候选均在护栏外且无超大票据时（理论罕见）

    // 从最优状态掩码提取组合成员
    const picked = [];
    const base = bestS * words;
    for (let i = 0; i < n; i++) {
      if (mask[base + (i >> 5)] & (1 << (i & 31))) picked.push(kept[i]);
    }
    return finish(picked, targetCents);
  }

  // 池内全部为超大票据（被 stateCap 裁掉）时，单张比较选优
  if (oversized.length > 0) {
    let bestBig = oversized[0];
    for (const it of oversized.slice(1)) {
      if (betterThan(it.cents, 1, it.mo, bestBig.cents, 1, bestBig.mo, targetCents)) bestBig = it;
    }
    return finish([bestBig], targetCents);
  }
  return null;
}

// 评分字典序比较：组合 (s1,c1,m1) 是否优于 (s2,c2,m2)
function betterThan(s1, c1, m1, s2, c2, m2, targetCents) {
  const d1 = Math.abs(s1 - targetCents);
  const d2 = Math.abs(s2 - targetCents);
  if (d1 !== d2) return d1 < d2;
  const over1 = s1 >= targetCents ? 1 : 0; // 差额打平时"凑够"优先
  const over2 = s2 >= targetCents ? 1 : 0;
  if (over1 !== over2) return over1 > over2;
  if (c1 !== c2) return c1 < c2;
  return m1 < m2;
}

function finish(picked, targetCents) {
  const sumCents = picked.reduce((s, i) => s + i.cents, 0);
  return {
    picked: picked.map((i) => i.id),
    sumCents,
    count: picked.length,
    exact: sumCents === targetCents,
    gapCents: sumCents - targetCents,
    monthSum: picked.reduce((s, i) => s + i.mo, 0), // 自检交叉验证用
  };
}

module.exports = { findBestMatch };

/* ===================== 自检（node matcher.js 直接运行） ===================== */
if (require.main === module) {
  const { findBestMatch: f } = module.exports;
  let pass = 0;
  let fail = 0;

  function check(name, cond, detail) {
    if (cond) { pass++; console.log(`  ok  ${name}`); }
    else { fail++; console.error(`FAIL  ${name}${detail ? ' :: ' + detail : ''}`); }
  }

  // 1. 恰好凑齐：多种组合可凑齐时选张数最少的
  let r = f([{ id: 1, cents: 100, monthOrd: 0 }, { id: 2, cents: 200, monthOrd: 0 }, { id: 3, cents: 300, monthOrd: 5 }], 300);
  check('精确凑齐取张数最少', r.exact && r.count === 1 && r.picked[0] === 3, JSON.stringify(r));

  // 2. 无法精确凑齐时取差额最小的组合
  r = f([{ id: 1, cents: 70, monthOrd: 0 }, { id: 2, cents: 90, monthOrd: 0 }], 100);
  check('无精确解取差额最小', r.sumCents === 90 && r.gapCents === -10, JSON.stringify(r));
  // 组合 70 差 30、90 差 10、160 超 60：90 的差额最小

  // 3. 池子总额不足：返回最接近（即全部可用组合中最优）的组合
  r = f([{ id: 1, cents: 100, monthOrd: 0 }, { id: 2, cents: 150, monthOrd: 0 }], 500);
  check('不足兜底取最接近组合', r.sumCents === 250 && r.gapCents === -250 && r.count === 2, JSON.stringify(r));

  // 4. 差额与张数打平时优先消化年月较早的票
  r = f([{ id: 1, cents: 100, monthOrd: 2026 * 12 }, { id: 2, cents: 100, monthOrd: 2024 * 12 }], 100);
  check('同额同张数取年月较早', r.picked[0] === 2, JSON.stringify(r));

  // 5. 差额打平时"凑够"优先于"差一点"
  r = f([{ id: 1, cents: 99, monthOrd: 0 }, { id: 2, cents: 101, monthOrd: 0 }], 100);
  check('差额打平凑够优先', r.picked[0] === 2, JSON.stringify(r));

  // 6. 张数上限：超限组合不可入选
  r = f(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, cents: 10, monthOrd: 0 })), 100, { maxCount: 10 });
  check('张数触顶仍可凑齐', r.exact && r.count === 10, JSON.stringify(r));
  r = f(Array.from({ length: 10 }, (_, i) => ({ id: i + 1, cents: 10, monthOrd: 0 })), 100, { maxCount: 3 });
  check('张数受限取最优短组合', r.sumCents === 30 && r.count === 3, JSON.stringify(r));

  // 7. 分值精度：0.1+0.2 量级的金额以整数分运算
  r = f([{ id: 1, cents: 10, monthOrd: 0 }, { id: 2, cents: 20, monthOrd: 0 }], 30);
  check('分值精度精确凑齐', r.exact && r.count === 2, JSON.stringify(r));

  // 8. 空池 / 非法输入
  check('空池返回 null', f([], 100) === null);
  check('非法目标返回 null', f([{ id: 1, cents: 10, monthOrd: 0 }], 0) === null);

  // 9. 掩码快照正确性（构造曾导致原地 DP 链路失真的场景）：
  //    多张等额票 + 追加更优月份票，最终组合成员必须互异且合计正确
  r = f([
    { id: 1, cents: 2, monthOrd: 30 }, { id: 2, cents: 2, monthOrd: 20 }, { id: 3, cents: 2, monthOrd: 10 },
    { id: 4, cents: 3, monthOrd: 40 },
  ], 4);
  const ids = new Set(r.picked);
  check('掩码组合成员互异', ids.size === r.count, JSON.stringify(r));
  check('掩码组合合计正确', r.count === 2 && r.sumCents === 4 && r.exact, JSON.stringify(r));

  // 10. 随机交叉验证：与暴力枚举的全局最优评分完全一致（组合可不同，评分必须相同）
  let mismatches = 0;
  for (let trial = 0; trial < 300; trial++) {
    const n = 1 + Math.floor(Math.random() * 12);
    const target = 1 + Math.floor(Math.random() * 600);
    const maxCount = 1 + Math.floor(Math.random() * 6);
    const pool = Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      cents: 1 + Math.floor(Math.random() * 300),
      monthOrd: Math.floor(Math.random() * 24),
    }));
    const key = (r) => {
      const sum = r.sumCents ?? r.sum;
      const mon = r.monthSum ?? r.mon ?? 0;
      return (r && r.count > 0)
        ? `${Math.abs(sum - target)}|${sum >= target ? 1 : 0}|${r.count}|${mon}`
        : 'none';
    };
    const got = f(pool, target, { maxCount });
    const brute = bruteForce(pool, target, maxCount);
    if (key(got) !== key(brute)) mismatches++;
  }
  check('随机 300 组与暴力枚举评分一致', mismatches === 0, `${mismatches} 组不一致`);

  // 11. 护栏：巨额票据触发 stateCap 时单张兜底不漏解
  r = f([{ id: 1, cents: 500000, monthOrd: 0 }], 10000, { stateCap: 250000 });
  check('超大票据单张兜底', r && r.picked[0] === 1 && r.count === 1, JSON.stringify(r));

  console.log(`\n${fail === 0 ? '全部通过' : '存在失败'}：${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;

  // —— 暴力枚举参照实现 ——
  function bruteForce(pool, target, maxCount) {
    let best = null;
    const n = pool.length;
    for (let bits = 1; bits < (1 << n); bits++) {
      const picked = [];
      for (let i = 0; i < n; i++) if (bits & (1 << i)) picked.push(pool[i]);
      if (picked.length > maxCount) continue;
      const sum = picked.reduce((s, i) => s + i.cents, 0);
      const mon = picked.reduce((s, i) => s + i.monthOrd, 0);
      if (best === null || betterThan(sum, picked.length, mon, best.sum, best.count, best.mon, target)) {
        best = { sum, count: picked.length, mon, picked: picked.map((i) => i.id) };
      }
    }
    return best || { sum: 0, count: 0, mon: 0, picked: [] };
  }
}
