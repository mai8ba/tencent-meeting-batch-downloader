/* HTTPS 响应时间，多源交叉校验。绝不读取电脑墙上时钟，不提供离线回退。
 *
 * 判定规则（v1.7.0）：
 *   1. 任意两个来源在 5 秒内一致 → 采用两者中较大的时间（保守）。
 *   2. 只有主源（meeting.tencent.com）可用时，允许单源通过 —— 但要求往返延迟
 *      ≤ 500ms。主源是插件本身的业务域名，劫持它需要有效证书；而 baidu/qq 只用来
 *      交叉校验，不单独授权，避免"只改一个 DNS 就能把试用时间挂住"。
 *   3. 其余情况一律拒绝，绝不回退到电脑时间。
 */
(() => {
  'use strict';
  const SOURCES = Object.freeze([
    'https://meeting.tencent.com/',
    'https://www.qq.com/',
    'https://www.baidu.com/'
  ]);
  const PRIMARY = SOURCES[0];
  const SINGLE_SOURCE_MAX_RTT = 500;
  const UNAVAILABLE = '无法校验联网时间，请检查网络后重试；限时授权暂不可用';
  function createClock({ fetcher = (...args) => fetch(...args), monotonic = () => performance.now(),
    nonce = () => crypto.randomUUID(), timeoutMs = 5000 } = {}) {
    let inFlight = null;
    async function sample(source, controller) {
      const started = monotonic();
      const url = new URL(source);
      url.searchParams.set('tmeet_time', nonce());
      const response = await fetcher(url.href, {
        method: 'HEAD', cache: 'no-store', credentials: 'omit', redirect: 'follow',
        referrerPolicy: 'no-referrer', headers: { 'Cache-Control': 'no-cache, no-store', Pragma: 'no-cache' },
        signal: controller.signal
      });
      const finished = monotonic();
      const rtt = finished - started;
      if (!response.ok || !Number.isFinite(rtt) || rtt < 0 || rtt > timeoutMs) throw new Error('时间源响应无效');
      // 允许跟随重定向（部分地区会跳到本地化路径），但最终地址必须仍是同一个源，
      // 否则等于把校时权交给第三方。
      if (response.url && new URL(response.url).origin !== url.origin) throw new Error('时间源被重定向到其他站点');
      const header = response.headers.get('date');
      const age = response.headers.get('age');
      // 拒绝缓存中存放过的响应；随机查询串和 no-store 降低命中缓存的可能。
      if (age !== null && (!/^\d+$/.test(age) || Number(age) !== 0)) throw new Error('时间源返回缓存数据');
      if (!header || !/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header)) throw new Error('缺少有效服务器时间');
      const value = Date.parse(header);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('服务器时间无效');
      // Date 头只有秒精度，使用保守上界，不把网络往返延迟当成剩余有效期。
      return { value: value + 1000 + rtt, received: finished, rtt, source };
    }
    async function sync() {
      const controllers = SOURCES.map(() => new AbortController());
      let timer;
      try {
        return await new Promise((resolve, reject) => {
          let settled = false, finished = 0;
          const samples = [];
          function finish(error, value) {
            if (settled) return;
            settled = true;
            error ? reject(error) : resolve(value);
          }
          timer = setTimeout(() => finish(new Error(UNAVAILABLE)), timeoutMs);
          SOURCES.forEach((source, index) => {
            sample(source, controllers[index]).then(result => {
              if (settled) return;
              samples.push(result);
              const current = monotonic();
              const times = samples.map(s => s.value + (current - s.received));
              for (let i = 0; i < times.length; i++) {
                for (let j = i + 1; j < times.length; j++) {
                  if (Math.abs(times[i] - times[j]) <= 5000) {
                    finish(null, Math.ceil(Math.max(times[i], times[j])));
                    return;
                  }
                }
              }
            }).catch(() => {}).finally(() => {
              if (++finished < SOURCES.length) return;
              // 全部结束后仍没有两个一致来源：仅在"唯一可用的是主源且延迟很小"时放行。
              const primary = samples.find(s => s.source === PRIMARY);
              if (samples.length === 1 && primary && primary.rtt <= SINGLE_SOURCE_MAX_RTT) {
                finish(null, Math.ceil(primary.value + (monotonic() - primary.received)));
                return;
              }
              finish(new Error(UNAVAILABLE));
            });
          });
        });
      } finally {
        clearTimeout(timer);
        controllers.forEach(c => c.abort());
      }
    }
    return Object.freeze({
      now() {
        // 只合并正在进行的请求；不缓存上次成功结果，断网后绝不沿用旧时间。
        if (!inFlight) inFlight = sync().finally(() => { inFlight = null; });
        return inFlight;
      }
    });
  }
  const clock = createClock();
  globalThis.TMeetNetworkTime = Object.freeze({ SOURCES, PRIMARY, SINGLE_SOURCE_MAX_RTT, createClock, now: () => clock.now() });
})();
