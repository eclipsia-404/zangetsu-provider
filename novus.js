var SOURCE_ID     = 'cinefreak';
var PROVIDER_NAME = 'CineFreak';
var BASE_URL      = 'https://cinefreak.net';
var CF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
  'Cookie':     'xla=s4t',
};

function _fetchHtml(url, extra) {
  return fetch(url, { headers: Object.assign({}, CF_HEADERS, extra || {}) })
    .then(function(r) { return r.ok ? r.body : null; })
    .catch(function() { return null; });
}

function _fetchJson(url, extra) {
  return fetch(url, { headers: Object.assign({}, CF_HEADERS, extra || {}) })
    .then(function(r) {
      if (!r.ok) return null;
      try { return JSON.parse(r.body); } catch(e) { return null; }
    })
    .catch(function() { return null; });
}

function _originOf(url) {
  var m = String(url).match(/^(https?:\/\/[^/]+)/);
  return m ? m[1] : '';
}

function _decodeBase64Url(str) {
  try {
    var norm = str.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    var bytes = base64ToBytes(norm);
    return bytes.map(function(b) { return String.fromCharCode(b); }).join('');
  } catch(e) { return null; }
}

function _toQualityLabel(raw) {
  var m = /(\d{3,4})[pP]/.exec(raw || '');
  if (!m) return 'Unknown';
  var n = parseInt(m[1], 10);
  if (n >= 2160) return '2160p';
  if (n >= 1080) return '1080p';
  if (n >= 720)  return '720p';
  if (n >= 480)  return '480p';
  return 'Unknown';
}

function _isHighQuality(q) {
  return q === '1080p' || q === '2160p';
}

function _formatTitle(releaseTitle, size, quality) {
  var t = String(releaseTitle || '');
  var line1Parts = [];
  if (quality) line1Parts.push(quality);
  if (size && size !== 'Unknown') line1Parts.push(size);

  var line2Parts = [];
  var src = /bluray|blu-ray|bdrip/i.test(t) ? 'Blu-ray'
    : /hdrip|webrip/i.test(t)               ? 'WEBRip'
    : /web-?dl/i.test(t)                    ? 'WEB-DL'
    : '';
  if (src) line2Parts.push(src);
  if (/imax/i.test(t)) line2Parts.push('IMAX');

  var audio = '';
  var am = t.match(/(TrueHD\s*7\.1|DDP\s*7\.1|DDP\s*5\.1|DD\s*5\.1|5\.1|AAC)/i);
  if (am) {
    audio = am[1].toUpperCase().replace(/\s+/g, '');
    if (audio === '5.1')                audio = 'DDP5.1';
    if (audio.indexOf('TRUEHD') !== -1) audio = 'TrueHD 7.1';
  } else if (/dolby\s*digital/i.test(t)) {
    audio = 'Dolby Digital';
  }
  if (/atmos/i.test(t)) audio = audio ? (audio + ' \u2022 Atmos') : 'Atmos';
  if (audio) line2Parts.push(audio);

  var range = /dolby\s*vision|dovi/i.test(t) ? 'Dolby Vision'
    : /hdr10/i.test(t)                        ? 'HDR10'
    : /hdr/i.test(t)                          ? 'HDR'
    : /10bit|10-bit/i.test(t)                 ? '10-Bit'
    : /\bsdr\b/i.test(t)                      ? 'SDR'
    : '';
  if (range) line2Parts.push(range);

  var codec = /hevc|x265|h\.?265/i.test(t) ? 'H.265'
    : /x264|h\.?264/i.test(t)              ? 'H.264'
    : '';
  if (codec) line2Parts.push(codec);

  return [line1Parts.join(' \u2022 '), line2Parts.join(' \u2022 ')].filter(Boolean).join('\n');
}

function _dedupe(streams) {
  var seen = {};
  return streams.filter(function(s) {
    if (!s.url || seen[s.url]) return false;
    seen[s.url] = true;
    return true;
  });
}

function _buildPageUrl(l) {
  l = l || '';
  return l.startsWith('http') ? l : BASE_URL + '/' + l.replace(/^\//, '') + '/';
}

function _parseMovieLinks(html) {
  var links  = [];
  var counts = {};
  var pos    = 0;

  while (true) {
    var h4Start = html.indexOf('<h4', pos);
    if (h4Start === -1) break;
    var h4End = html.indexOf('</h4>', h4Start);
    if (h4End === -1) break;
    var h4Tag = html.substring(h4Start, h4End + 5);

    if (!/class="[^"]*movie-title[^"]*"/i.test(h4Tag)) { pos = h4End + 5; continue; }

    var h4Text = h4Tag.replace(/<[^>]+>/g, '');
    var qm = /(2160p|1080p|720p|480p)/i.exec(h4Text);
    if (!qm) { pos = h4End + 5; continue; }
    var quality = qm[1];

    var nextH4  = html.indexOf('<h4', h4End + 5);
    var secEnd  = nextH4 !== -1 ? nextH4 : Math.min(h4End + 6000, html.length);
    var section = html.substring(h4End + 5, secEnd);

    var sp = 0;
    while (true) {
      var as = section.indexOf('<a ', sp);
      if (as === -1) break;
      var ae = section.indexOf('</a>', as);
      if (ae === -1) break;
      var aTag = section.substring(as, ae + 4);
      if (/class="[^"]*dlbtn-download[^"]*"/i.test(aTag)) {
        var hm = aTag.match(/href="([^"]+)"/i);
        if (hm && hm[1].trim()) {
          counts[quality] = (counts[quality] || 0) + 1;
          var label = counts[quality] === 1 ? quality : quality + '_' + counts[quality];
          links.push({ quality: label, href: hm[1].trim() });
        }
      }
      sp = ae + 4;
    }

    pos = h4End + 5;
  }

  return links;
}

function _collectGenerateLinks(cardHtml) {
  var NEEDLE = '/generate.php?id=';
  var links  = [];
  var pos    = 0;

  while (true) {
    var hrefStart = cardHtml.indexOf(NEEDLE, pos);
    if (hrefStart === -1) break;

    var aOpen = cardHtml.lastIndexOf('<a ', hrefStart);
    if (aOpen === -1 || aOpen < pos) { pos = hrefStart + 1; continue; }

    var aClose = cardHtml.indexOf('</a>', hrefStart);
    if (aClose === -1) { pos = hrefStart + 1; continue; }

    var gtIdx = cardHtml.indexOf('>', hrefStart);
    if (gtIdx === -1 || gtIdx > aClose) { pos = aClose + 4; continue; }

    var label    = cardHtml.substring(gtIdx + 1, aClose).trim();
    var quoteIdx = cardHtml.indexOf('"', hrefStart);
    if (quoteIdx === -1) { pos = aClose + 4; continue; }

    var snippet = cardHtml.substring(hrefStart, quoteIdx);
    var idMatch = snippet.match(/id=([a-zA-Z0-9+/=]+)/);
    if (!idMatch) { pos = aClose + 4; continue; }

    var hrefTagStart = cardHtml.lastIndexOf('href="', hrefStart);
    var fullHref = cardHtml
      .substring(hrefTagStart + 6, cardHtml.indexOf('"', hrefTagStart + 6))
      .replace(/&amp;/g, '&');

    var qm      = /(2160p|1080p|720p|480p)/i.exec(label);
    var quality = qm ? qm[1] : (label || 'Unknown');

    links.push({ href: fullHref || (NEEDLE + idMatch[1]), quality: quality });
    pos = aClose + 4;
  }

  return links;
}

function _parseEpisodeLinks(html, targetEpisode) {
  if (!html) return [];
  var cards = html.split('<div class="ep-card"');
  var EP_PATTERNS = [
    /episode-badge[^>]*>\s*(?:Episode\s*)?(\d+)/i,
    /ep-num[^>]*>\s*(\d+)\s*</i,
    /data-episode="(\d+)"/i,
    /\bEpisode\s+(\d+)\b/i,
  ];
  for (var i = 1; i < cards.length; i++) {
    for (var p = 0; p < EP_PATTERNS.length; p++) {
      var m = cards[i].match(EP_PATTERNS[p]);
      if (m && parseInt(m[1], 10) === targetEpisode) {
        return _collectGenerateLinks(cards[i]);
      }
    }
  }
  return [];
}

function _parseEpisodeList(html) {
  var cards = html.split('<div class="ep-card"');
  var episodes = [];
  var seen = {};
  var EP_PATTERNS = [
    /episode-badge[^>]*>\s*(?:Episode\s*)?(\d+)/i,
    /ep-num[^>]*>\s*(\d+)\s*</i,
    /data-episode="(\d+)"/i,
    /\bEpisode\s+(\d+)\b/i,
  ];
  for (var i = 1; i < cards.length; i++) {
    for (var p = 0; p < EP_PATTERNS.length; p++) {
      var m = cards[i].match(EP_PATTERNS[p]);
      if (m) {
        var n = parseInt(m[1], 10);
        if (!seen[n]) {
          seen[n] = true;
          episodes.push({ id: 'ep-' + n, title: 'Episode ' + n, number: n });
        }
        break;
      }
    }
  }
  episodes.sort(function(a, b) { return a.number - b.number; });
  return episodes;
}

function _extractCineCloud(url, qualityHint) {
  var quality = _toQualityLabel(qualityHint);
  if (!_isHighQuality(quality)) return Promise.resolve([]);

  return _fetchHtml(url).then(function(html) {
    if (!html) return [];
    var streams = [];

    var releaseTitle = '';
    var candidates = [
      ((html.match(/<h1[^>]*>([^<]+)<\/h1>/i) || [])[1] || '').trim(),
      ((html.match(/<h2[^>]*>([^<]+)<\/h2>/i) || [])[1] || '').trim(),
      ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || '').trim(),
      ((html.match(/class="(?:file-name|filename|release-name|movie-title)"[^>]*>([^<]+)</i) || [])[1] || '').trim(),
    ];
    for (var ci = 0; ci < candidates.length; ci++) {
      if (candidates[ci] && /\d{3,4}p|bluray|webrip|web-?dl|x26[45]|hevc|aac|ddp/i.test(candidates[ci])) {
        releaseTitle = candidates[ci];
        break;
      }
    }

    var fileSize = '';
    var rows = html.split('<tr>');
    for (var ri = 0; ri < rows.length; ri++) {
      if (/file\s*size/i.test(rows[ri])) {
        var fsm = rows[ri].match(/class="[^"]*text-right[^"]*"[^>]*>([^<]+)<\/td>/i);
        if (fsm) { fileSize = fsm[1].trim(); break; }
      }
    }

    var sizeLabel  = _formatTitle(releaseTitle, fileSize, quality);
    var base       = _originOf(url);
    var resumeJobs = [];

    var lp = 0;
    while (true) {
      var as = html.indexOf('<a ', lp);
      if (as === -1) break;
      var ae = html.indexOf('</a>', as);
      if (ae === -1) break;
      var aTag = html.substring(as, ae + 4);
      var hm   = aTag.match(/href="([^"]+)"/i);
      if (hm) {
        var href     = hm[1].trim();
        var fullHref = href.startsWith('http') ? href : base + href;
        var text     = aTag.replace(/<[^>]+>/g, '').trim();
        if (/fast\s+cloud/i.test(text) || /\[fsl\]/i.test(text)) {
          streams.push({ url: fullHref, title: PROVIDER_NAME + ' \u2022 FSL',
                         size: sizeLabel, headers: { Referer: url } });
        } else if (/cloud\s*\[resumable\]/i.test(text)) {
          resumeJobs.push(fullHref);
        }
      }
      lp = ae + 4;
    }

    return Promise.allSettled(
      resumeJobs.map(function(resumeUrl) {
        return _fetchHtml(resumeUrl, { Referer: url }).then(function(subHtml) {
          if (!subHtml) return [];
          var subLinks = [];
          var sp = 0;
          while (true) {
            var si = subHtml.indexOf('<a ', sp);
            if (si === -1) break;
            var se = subHtml.indexOf('</a>', si);
            if (se === -1) break;
            var st = subHtml.substring(si, se + 4);
            if (/class="[^"]*download-now[^"]*"/i.test(st)) {
              var lm = st.match(/href="([^"]+)"/i);
              if (lm) subLinks.push(lm[1].trim());
            }
            sp = se + 4;
          }
          return subLinks;
        }).catch(function() { return []; });
      })
    ).then(function(results) {
      for (var i = 0; i < results.length; i++) {
        if (results[i].status !== 'fulfilled') continue;
        var finalLinks = results[i].value;
        for (var j = 0; j < finalLinks.length; j++) {
          streams.push({ url: finalLinks[j], title: PROVIDER_NAME + ' \u2022 R2',
                         size: sizeLabel, headers: { Referer: url } });
        }
      }
      return streams;
    });
  }).catch(function() { return []; });
}

function _resolveLink(href, qualityHint) {
  try {
    var m = /[?&]id=([^&]+)/.exec(href);
    if (!m) return Promise.resolve([]);

    var encoded = m[1];
    try { encoded = decodeURIComponent(encoded); } catch(e) {}

    var decoded = _decodeBase64Url(encoded);
    if (!decoded) return Promise.resolve([]);

    var target = decoded.split('newgo32')[0].trim();
    if (!target || target.indexOf('http') !== 0) return Promise.resolve([]);

    if (target.indexOf('cinecloud') !== -1) return _extractCineCloud(target, qualityHint);

    return Promise.resolve([]);
  } catch(e) { return Promise.resolve([]); }
}

function _streamsToVideoSources(streams) {
  return _dedupe(streams).map(function(s) {
    var qualityLine = s.size ? s.size.split('\n')[0] : 'Unknown';
    return {
      url:       s.url,
      quality:   qualityLine,
      container: 'mp4',
      headers:   s.headers || {},
      kind:      'raw',
      subtitles: [],
      label:     s.title || PROVIDER_NAME,
    };
  });
}

function _resolveAllLinks(rawLinks) {
  return Promise.allSettled(
    rawLinks.map(function(link) { return _resolveLink(link.href, link.quality); })
  ).then(function(batches) {
    var streams = [];
    for (var i = 0; i < batches.length; i++) {
      if (batches[i].status === 'fulfilled') {
        streams = streams.concat(batches[i].value);
      }
    }
    return _streamsToVideoSources(streams);
  });
}

function getInfo() {
  return {
    name:    'CineFreak',
    lang:    'en',
    baseUrl: BASE_URL,
    logo:    BASE_URL + '/favicon.ico',
    type:    'movie',
    version: '1.0.0',
  };
}

function search(query, page, opts) {
  var pg = page || 1;
  return _fetchJson(BASE_URL + '/search-api.php?q=' + encodeURIComponent(query) + '&pg=' + pg)
    .then(function(j) {
      var results = (j && Array.isArray(j.results)) ? j.results : [];
      return results.map(function(item) {
        var pageUrl = _buildPageUrl(item.l);
        return {
          id:       pageUrl,
          title:    item.t || 'Unknown',
          url:      pageUrl,
          type:     'movie',
          sourceId: SOURCE_ID,
        };
      });
    }).catch(function() { return []; });
}

function getDetail(url, opts) {
  return _fetchHtml(url).then(function(html) {
    if (!html) return null;

    var tm = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    var title = tm
      ? htmlText(tm[1].replace(/\s*[-|]\s*CineFreak.*$/i, '').trim())
      : 'Unknown';

    var cm = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
          || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i)
          || html.match(/<img[^>]+class="[^"]*poster[^"]*"[^>]+src="([^"]+)"/i);
    var cover = cm ? cm[1] : null;

    var dm = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i)
          || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="description"/i);
    var description = dm ? htmlText(dm[1]) : '';

    var isTv = html.indexOf('<div class="ep-card"') !== -1;
    var episodes;

    if (isTv) {
      var epList = _parseEpisodeList(html);
      episodes = epList.map(function(ep) {
        return {
          id:     ep.id,
          title:  ep.title,
          number: ep.number,
          url:    'cf_tv|' + encodeURIComponent(url) + '|' + ep.number,
        };
      });
    } else {
      episodes = [{
        id:     'movie-1',
        title:  title,
        number: 1,
        url:    'cf_movie|' + encodeURIComponent(url),
      }];
    }

    return {
      id:          url,
      title:       title,
      url:         url,
      type:        'movie',
      sourceId:    SOURCE_ID,
      cover:       cover,
      description: description,
      status:      'unknown',
      episodes:    episodes,
    };
  }).catch(function() { return null; });
}

function getEpisodes(url, opts) {
  return getDetail(url, opts).then(function(d) { return d ? d.episodes : []; });
}

function getVideoSources(episodeUrl) {
  var sep   = '|';
  var first = episodeUrl.indexOf(sep);
  if (first === -1) return Promise.resolve([]);

  var scheme = episodeUrl.substring(0, first);
  var rest   = episodeUrl.substring(first + 1);

  if (scheme === 'cf_movie') {
    var pageUrl = decodeURIComponent(rest);
    return _fetchHtml(pageUrl)
      .then(function(html) {
        if (!html) return [];
        return _resolveAllLinks(_parseMovieLinks(html));
      })
      .catch(function() { return []; });
  }

  if (scheme === 'cf_tv') {
    var pipeIdx = rest.indexOf(sep);
    if (pipeIdx === -1) return Promise.resolve([]);
    var tvPageUrl = decodeURIComponent(rest.substring(0, pipeIdx));
    var epNum     = parseInt(rest.substring(pipeIdx + 1), 10);
    return _fetchHtml(tvPageUrl)
      .then(function(html) {
        if (!html) return [];
        return _resolveAllLinks(_parseEpisodeLinks(html, epNum));
      })
      .catch(function() { return []; });
  }

  return Promise.resolve([]);
}
