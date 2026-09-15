'use strict';

function parseCount(value) {
  const n = Number(String(value || '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Pull countable progress out of a job status / log line.
 * Supports:
 *   [720/8795] …                 inbox scan / remove
 *   120/5,000 this run           connections download
 *   Listing… 123 … of 456 listed inbox cache / list pass
 *   reading 8795 with N tab(s)   upcoming scan size
 */
function parseProgressFromLine(line) {
  const text = String(line || '').trim();
  if (!text) {
    return null;
  }

  const bracket = text.match(/\[(\d[\d,]*)\/(\d[\d,]*)\]/);
  if (bracket) {
    const current = parseCount(bracket[1]);
    const total = parseCount(bracket[2]);
    if (total > 0 && current >= 0) {
      return {
        current: Math.min(current, total),
        total,
        source: 'bracket',
      };
    }
  }

  const download = text.match(/(\d[\d,]*)\/(\d[\d,]*)\s+this run\b/i);
  if (download) {
    const current = parseCount(download[1]);
    const total = parseCount(download[2]);
    if (total > 0 && current >= 0) {
      return {
        current: Math.min(current, total),
        total,
        source: 'download-run',
      };
    }
  }

  const reading = text.match(/\breading\s+(\d[\d,]*)\s+with\s+\d+\s+tab/i);
  if (reading) {
    const total = parseCount(reading[1]);
    if (total > 0) {
      return { current: 0, total, source: 'reading-total' };
    }
  }

  const listing = text.match(
    /Listing…\s*(\d[\d,]*)\s+connection conversation\(s\) of\s+(\d[\d,]*)\s+listed/i
  );
  if (listing) {
    const kept = parseCount(listing[1]);
    const listed = parseCount(listing[2]);
    if (listed > 0) {
      return {
        current: listed,
        total: null,
        kept: Number.isFinite(kept) ? kept : null,
        source: 'listing',
      };
    }
  }

  return null;
}

function formatEtaRemaining(ms) {
  const seconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (seconds < 45) {
    return 'less than a minute remaining';
  }
  if (seconds < 90) {
    return 'about 1 minute remaining';
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `about ${minutes}m remaining`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 48) {
    return remMinutes === 0
      ? `about ${hours}h remaining`
      : `about ${hours}h ${remMinutes}m remaining`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours === 0
    ? `about ${days}d remaining`
    : `about ${days}d ${remHours}h remaining`;
}

function formatPace(unitsPerMs, unitLabel) {
  const perMinute = (Number(unitsPerMs) || 0) * 60 * 1000;
  if (!(perMinute > 0)) {
    return null;
  }
  if (perMinute < 1) {
    const perHour = perMinute * 60;
    if (perHour < 1) {
      return null;
    }
    return `~${Math.round(perHour).toLocaleString()} ${unitLabel}/h`;
  }
  if (perMinute < 10) {
    return `~${perMinute.toFixed(1)} ${unitLabel}/min`;
  }
  return `~${Math.round(perMinute).toLocaleString()} ${unitLabel}/min`;
}

function createJobEtaTracker(options = {}) {
  const startedAt = Number(options.startedAt) || Date.now();
  const samples = [];
  let last = null;

  function pushSample(at, current, total, source) {
    samples.push({ t: at, current, total, source });
    if (samples.length > 48) {
      samples.splice(0, samples.length - 48);
    }
    last = { current, total, source, at };
  }

  function rateFromSamples(at) {
    if (samples.length < 2) {
      return null;
    }
    const newest = samples[samples.length - 1];
    let oldest = samples[0];
    for (let i = 0; i < samples.length - 1; i += 1) {
      // Prefer a recent window (up to ~3 minutes) once we have one.
      if (newest.t - samples[i].t <= 180000) {
        oldest = samples[i];
        break;
      }
      oldest = samples[i];
    }
    const deltaUnits = newest.current - oldest.current;
    const deltaMs = newest.t - oldest.t;
    if (deltaUnits > 0 && deltaMs >= 4000) {
      return deltaUnits / deltaMs;
    }
    return null;
  }

  function rateFromStart(at, current) {
    const elapsed = at - startedAt;
    if (current > 0 && elapsed >= 8000) {
      return current / elapsed;
    }
    return null;
  }

  function observe(line, at = Date.now()) {
    const parsed = parseProgressFromLine(line);
    if (!parsed) {
      return snapshot(at);
    }

    if (parsed.total == null) {
      // Listing without a known endpoint — keep samples for pace only.
      pushSample(at, parsed.current, null, parsed.source);
      return snapshot(at);
    }

    // Ignore noisy zero-totals and identical repeats that would flatten the rate.
    const sameAsLast =
      last &&
      last.total === parsed.total &&
      last.current === parsed.current &&
      last.source === parsed.source;
    if (!sameAsLast) {
      pushSample(at, parsed.current, parsed.total, parsed.source);
    } else {
      last.at = at;
    }
    return snapshot(at);
  }

  function snapshot(at = Date.now()) {
    if (!last) {
      return {
        progress: null,
        etaMs: null,
        etaLabel: null,
        paceLabel: null,
        computedAt: at,
      };
    }

    const rate = rateFromSamples(at) || rateFromStart(at, last.current);
    const paceLabel =
      last.total == null
        ? formatPace(rate, 'conversations')
        : formatPace(rate, last.source === 'download-run' ? 'connections' : 'items');

    if (last.total == null || !(last.total > 0)) {
      return {
        progress: {
          current: last.current,
          total: null,
          ratio: null,
          source: last.source,
        },
        etaMs: null,
        etaLabel: paceLabel,
        paceLabel,
        computedAt: at,
      };
    }

    const remaining = Math.max(0, last.total - last.current);
    const progress = {
      current: last.current,
      total: last.total,
      ratio: last.current / last.total,
      source: last.source,
    };

    if (remaining === 0) {
      return {
        progress,
        etaMs: 0,
        etaLabel: 'finishing…',
        paceLabel,
        computedAt: at,
      };
    }

    if (!(rate > 0)) {
      return {
        progress,
        etaMs: null,
        etaLabel: null,
        paceLabel: null,
        computedAt: at,
      };
    }

    const etaMs = remaining / rate;
    return {
      progress,
      etaMs,
      etaLabel: formatEtaRemaining(etaMs),
      paceLabel,
      computedAt: at,
    };
  }

  return {
    observe,
    snapshot,
    startedAt,
  };
}

module.exports = {
  parseCount,
  parseProgressFromLine,
  formatEtaRemaining,
  formatPace,
  createJobEtaTracker,
};
