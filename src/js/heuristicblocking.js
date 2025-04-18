/*
 * This file is part of Privacy Badger <https://privacybadger.org/>
 * Copyright (C) 2014 Electronic Frontier Foundation
 *
 * Privacy Badger is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License version 3 as
 * published by the Free Software Foundation.
 *
 * Privacy Badger is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Privacy Badger.  If not, see <http://www.gnu.org/licenses/>.
 */

/* globals badger:false */

import { extractHostFromURL, getBaseDomain, URI } from "../lib/basedomain.js";
import { getInitiatorUrl } from "../lib/webrequestUtils.js";

import { log } from "./bootstrap.js";
import constants from "./constants.js";
import utils from "./utils.js";

/*********************** heuristicblocking scope **/
// make heuristic obj with utils and storage properties and put the things on it
function HeuristicBlocker(pbStorage) {
  let self = this;

  self.storage = pbStorage;

  // TODO roll into tabData? -- 6/10/2019 not for now, since tabData is populated
  // by the synchronous listeners in webrequests.js and tabBases is used by the
  // async listeners here; there's no way to enforce ordering of requests among
  // those two. Also, tabData is cleaned up every time a tab is closed, so
  // dangling requests that don't trigger listeners until after the tab closes are
  // impossible to attribute to a tab.
  self.tabBases = {};
  self.tabUrls = {};
}

HeuristicBlocker.prototype = {

  /**
   * Initializes tab bases and URLs for already-open tabs
   */
  initTabData: function (tab_id, tab_url) {
    let self = this;
    self.tabBases[tab_id] = getBaseDomain((new URI(tab_url)).host);
    self.tabUrls[tab_id] = tab_url;
  },

  /**
   * Blocklists a domain:
   *
   * - Blocks or cookieblocks the given domain.
   * - Blocks or cookieblocks its eTLD+1 ("base" domain).
   * - Cookieblocks any yellowlisted subdomains that
   *   share the base domain with the given domain.
   *
   * @param {String} base The base domain (eTLD+1) to blocklist
   * @param {String} fqdn The domain to blocklist
   */
  blocklistDomain: function (base, fqdn) {
    let self = this,
      ylistStorage = self.storage.getStore("cookieblock_list");

    // cookieblock or block the base domain
    if (ylistStorage.hasItem(base)) {
      self.storage.setupHeuristicAction(base, constants.COOKIEBLOCK);
    } else {
      self.storage.setupHeuristicAction(base, constants.BLOCK);
    }

    // cookieblock or block the fqdn
    //
    // cookieblock if a "parent" domain of the fqdn is on the yellowlist
    //
    // ignore base domains when exploding to work around PSL TLDs:
    // still want to cookieblock somedomain.googleapis.com with only
    // googleapis.com (and not somedomain.googleapis.com itself) on the ylist
    let set = false,
      subdomains = utils.explodeSubdomains(fqdn, true);
    for (let i = 0; i < subdomains.length; i++) {
      if (ylistStorage.hasItem(subdomains[i])) {
        set = true;
        break;
      }
    }
    if (set) {
      self.storage.setupHeuristicAction(fqdn, constants.COOKIEBLOCK);
    } else {
      self.storage.setupHeuristicAction(fqdn, constants.BLOCK);
    }

    // cookieblock any yellowlisted subdomains with the same base domain
    //
    // for example, when google.com is blocked,
    // books.google.com should be cookieblocked
    let base_with_dot = '.' + base;
    ylistStorage.keys().forEach(domain => {
      if (base != domain && domain.endsWith(base_with_dot)) {
        self.storage.setupHeuristicAction(domain, constants.COOKIEBLOCK);
      }
    });

  },

  /**
   * Checks whether `details` is a third-party Beacon API request.
   *
   * Otherwise, checks third-party requests/responses for tracking cookies.
   *
   * This wraps _recordPrevalence for use from webRequest listeners.
   * Use updateTrackerPrevalence for non-webRequest initiated bookkeeping.
   *
   * @param {Object} details webRequest request/response details object
   */
  checkForTrackingCookies: function (details) {
    // ignore requests that are outside a tabbed window
    if (details.tabId < 0 || !badger.isLearningEnabled(details.tabId)) {
      return;
    }

    let self = this,
      tab_id = details.tabId,
      from_current_tab = true;

    // if this is a main window request, update tab data and quit
    if (details.type == "main_frame") {
      let tab_host = (new URI(details.url)).host;
      self.tabBases[tab_id] = getBaseDomain(tab_host);
      self.tabUrls[tab_id] = details.url;
      return;
    }

    let tab_base = self.tabBases[tab_id];
    if (!tab_base) {
      return;
    }

    let request_host = (new URI(details.url)).host;
    // CNAME uncloaking
    if (utils.hasOwn(badger.cnameDomains, request_host)) {
      // TODO details.url is still wrong
      request_host = badger.cnameDomains[request_host];
    }
    let request_base = getBaseDomain(request_host);

    let initiator_url = getInitiatorUrl(self.tabUrls[tab_id], details);
    if (initiator_url) {
      from_current_tab = false;
      tab_base = getBaseDomain(extractHostFromURL(initiator_url));
    }

    // ignore first-party requests
    if (!utils.isThirdPartyDomain(request_base, tab_base)) {
      return;
    }

    // short-circuit if we already observed this eTLD+1 tracking on this site
    let firstParties = self.storage.getStore('snitch_map').getItem(request_base);
    if (firstParties && firstParties.includes(tab_base)) {
      return;
    }

    // short-circuit if we already made a decision for this FQDN
    let action = self.storage.getBestAction(request_host);
    if (action != constants.NO_TRACKING && action != constants.ALLOW) {
      return;
    }

    if (details.type == "beacon" || details.type == "ping") {
      self._recordPrevalence(request_host, request_base, tab_base);
      // update tracking_map
      badger.storage.recordTrackingDetails(request_base, tab_base, 'beacon');
      // log in popup
      if (from_current_tab) {
        badger.logThirdParty(
          tab_id, request_host, badger.storage.getBestAction(request_host));
      }
      // don't bother checking for tracking cookies
      return;
    }

    // check if there are tracking cookies
    if (hasCookieTracking(details)) {
      self._recordPrevalence(request_host, request_base, tab_base);
    }
  },

  /**
   * Calls the pixel cookie sharing checking function
   * iff the request is for an image in the top-level frame,
   * and the request URL has querystring parameters.
   *
   * @param {Object} details webRequest onResponseStarted details object
   */
  checkForPixelCookieSharing: function (details) {
    if (!badger.isLearningEnabled(details.tabId)) {
      return;
    }

    if (details.type != 'image' || details.frameId !== 0 || details.url.indexOf('?') == -1) {
      return;
    }

    let self = this,
      tab_base = self.tabBases[details.tabId];
    if (!tab_base) {
      return;
    }
    let tab_url = self.tabUrls[details.tabId];

    let request_host = (new URI(details.url)).host;
    // CNAME uncloaking
    if (utils.hasOwn(badger.cnameDomains, request_host)) {
      request_host = badger.cnameDomains[request_host];
    }
    let request_base = getBaseDomain(request_host);

    let initiator_url = getInitiatorUrl(tab_url, details);
    if (initiator_url) {
      tab_url = initiator_url;
      tab_base = getBaseDomain(extractHostFromURL(initiator_url));
    }

    // ignore first-party requests
    if (!utils.isThirdPartyDomain(request_base, tab_base)) {
      return;
    }

    // short-circuit if we already observed this eTLD+1 tracking on this site
    let firstParties = self.storage.getStore('snitch_map').getItem(request_base);
    if (firstParties && firstParties.includes(tab_base)) {
      return;
    }

    // short-circuit if we already made a decision for this FQDN
    let action = self.storage.getBestAction(request_host);
    if (action != constants.NO_TRACKING && action != constants.ALLOW) {
      return;
    }

    // get all non-HttpOnly cookies for the top-level frame
    // and pass those to the pixel cookie-share accounting function
    let config = {
      url: tab_url
    };
    if (badger.firstPartyDomainPotentiallyRequired) {
      config.firstPartyDomain = null;
    }
    chrome.cookies.getAll(config, function (cookies) {
      cookies = cookies.filter(cookie => !cookie.httpOnly);
      if (cookies.length < 1) {
        return;
      }

      // TODO refactor with new URI() above?
      let searchParams = (new URL(details.url)).searchParams;

      self.pixelCookieShareAccounting(tab_url, tab_base, searchParams, request_host, request_base, cookies);
    });
  },

  /**
   * Checks for cookie sharing: requests to third-party domains
   * that include high entropy data from first-party cookies.
   *
   * Only catches plain-text verbatim sharing (b64 encoding etc. defeat it).
   *
   * Assumes any long string that doesn't contain URL fragments
   * or stopwords is an identifier.
   *
   * Doesn't catch cookie syncing (3rd party -> 3rd party),
   * but most of those tracking cookies should be blocked anyway.
   */
  pixelCookieShareAccounting: function (tab_url, tab_base, searchParams, request_host, request_base, cookies) {
    const TRACKER_ENTROPY_THRESHOLD = 33,
      MIN_STR_LEN = 8;

    let self = this;

    for (let p of searchParams) {
      let key = p[0],
        value = p[1];

      // the argument must be sufficiently long
      if (!value || value.length < MIN_STR_LEN) {
        continue;
      }

      // check if this argument is derived from a high-entropy first-party cookie
      for (let cookie of cookies) {
        // the cookie value must be sufficiently long
        if (!cookie.value || cookie.value.length < MIN_STR_LEN) {
          continue;
        }

        // find the longest common substring between this arg and the cookies
        // associated with the document
        let substrings = utils.findCommonSubstrings(cookie.value, value) || [];
        for (let s of substrings) {
          // ignore the substring if it's part of the first-party URL. sometimes
          // content servers take the url of the page they're hosting content
          // for as an argument. e.g.
          // https://example-cdn.com/content?u=http://example.com/index.html
          if (tab_url.indexOf(s) != -1) {
            continue;
          }

          // elements of the user agent string are also commonly included in
          // both cookies and arguments; e.g. "Mozilla/5.0" might be in both.
          // This is not a special tracking risk since third parties can see
          // this info anyway.
          if (navigator.userAgent.indexOf(s) != -1) {
            continue;
          }

          // Sometimes the entire url and then some is included in the
          // substring -- the common string might be "https://example.com/:true"
          // In that case, we only care about the information around the URL.
          if (s.indexOf(tab_url) != -1) {
            s = s.replace(tab_url, "");
          }

          // During testing we found lots of common values like "homepage",
          // "referrer", etc. were being flagged as high entropy. This searches
          // for a few of those and removes them before we go further.
          let lower = s.toLowerCase();
          lowEntropyQueryValues.forEach(function (qv) {
            let start = lower.indexOf(qv);
            if (start != -1) {
              s = s.replace(s.substring(start, start + qv.length), "");
            }
          });

          // at this point, since we might have removed things, make sure the
          // string is still long enough to bother with
          if (s.length < MIN_STR_LEN) {
            continue;
          }

          // compute the entropy of this common substring. if it's greater than
          // our threshold, record the tracking action and exit the function.
          let entropy = utils.estimateMaxEntropy(s);
          if (entropy > TRACKER_ENTROPY_THRESHOLD) {
            log("Found high-entropy cookie share from", tab_base, "to", request_host,
              ":", entropy, "bits\n  cookie:", cookie.name, '=', cookie.value,
              "\n  arg:", key, "=", value, "\n  substring:", s);
            self._recordPrevalence(request_host, request_base, tab_base);

            // record pixel cookie sharing
            badger.storage.recordTrackingDetails(
              request_base, tab_base, 'pixelcookieshare');

            return;
          }
        }
      }
    }
  },

  /**
   * Wraps _recordPrevalence for use outside of webRequest listeners.
   *
   * @param {String} tracker_fqdn The fully qualified domain name of the tracker
   * @param {String} tracker_base Base domain of the third party tracker
   * @param {String} site_base Base domain of page where tracking occurred
   */
  updateTrackerPrevalence: function (tracker_fqdn, tracker_base, site_base) {
    // short-circuit if we already made a decision for this fqdn
    let action = this.storage.getBestAction(tracker_fqdn);
    if (action != constants.NO_TRACKING && action != constants.ALLOW) {
      return;
    }

    this._recordPrevalence(
      tracker_fqdn,
      tracker_base,
      site_base
    );
  },

  /**
   * Record HTTP request prevalence. Block a tracker if seen on more
   * than constants.TRACKING_THRESHOLD pages.
   *
   * NOTE: This is a private function and should never be called directly.
   * All calls should be routed through checkForTrackingCookies for normal usage
   * and updateTrackerPrevalence for manual modifications (e.g. importing
   * tracker lists).
   *
   * @param {String} tracker_fqdn The FQDN of the third party tracker
   * @param {String} tracker_base Base domain of the third party tracker
   * @param {String} site_base Base domain of page where tracking occurred
   */
  _recordPrevalence: function (tracker_fqdn, tracker_base, site_base) {
    // GDPR Consent Management Provider
    // https://github.com/EFForg/privacybadger/pull/2245#issuecomment-545545717
    if (tracker_base == "consensu.org") {
      return;
    }

    // do not record Cisco OpenDNS/Umbrella proxy domains
    if (tracker_fqdn.endsWith(".id.opendns.com")) {
      return;
    }

    let self = this,
      firstParties = [],
      actionMap = self.storage.getStore('action_map'),
      snitchMap = self.storage.getStore('snitch_map');

    if (!actionMap.hasItem(tracker_fqdn)) {
      self.storage.setupHeuristicAction(tracker_fqdn, constants.ALLOW);
      if (!actionMap.hasItem(tracker_base)) {
        self.storage.setupHeuristicAction(tracker_base, constants.ALLOW);
      }
    }

    if (snitchMap.hasItem(tracker_base)) {
      firstParties = snitchMap.getItem(tracker_base);
    }

    // do not record if already recorded this tracker on the given domain
    if (firstParties.includes(site_base)) {
      return;
    }

    // record that we've seen this tracker on this domain
    firstParties.push(site_base);
    snitchMap.setItem(tracker_base, firstParties);

    // (cookie)block if domain was seen tracking on enough first party domains
    if (firstParties.length >=
        self.storage.getStore('private_storage').getItem('blockThreshold')) {
      self.blocklistDomain(tracker_base, tracker_fqdn);
    }
  }
};


// This maps cookies to a rough estimate of how many bits of
// identifying info we might be letting past by allowing them.
// (map values to lower case before using)
// TODO: We need a better heuristic
var lowEntropyCookieValues = {
  "":3,
  "nodata":3,
  "no_data":3,
  "yes":3,
  "no":3,
  "true":3,
  "false":3,
  "dnt":3,
  "opt-out":3,
  "optout":3,
  "opt_out":3,
  "0":4,
  "1":4,
  "2":4,
  "3":4,
  "4":4,
  "5":4,
  "6":4,
  "7":4,
  "8":4,
  "9":4,
  // ISO 639-1 language codes
  "aa":8,
  "ab":8,
  "ae":8,
  "af":8,
  "ak":8,
  "am":8,
  "an":8,
  "ar":8,
  "as":8,
  "av":8,
  "ay":8,
  "az":8,
  "ba":8,
  "be":8,
  "bg":8,
  "bh":8,
  "bi":8,
  "bm":8,
  "bn":8,
  "bo":8,
  "br":8,
  "bs":8,
  "by":8,
  "ca":8,
  "ce":8,
  "ch":8,
  "co":8,
  "cr":8,
  "cs":8,
  "cu":8,
  "cv":8,
  "cy":8,
  "da":8,
  "de":8,
  "dv":8,
  "dz":8,
  "ee":8,
  "el":8,
  "en":8,
  "eo":8,
  "es":8,
  "et":8,
  "eu":8,
  "fa":8,
  "ff":8,
  "fi":8,
  "fj":8,
  "fo":8,
  "fr":8,
  "fy":8,
  "ga":8,
  "gd":8,
  "gl":8,
  "gn":8,
  "gu":8,
  "gv":8,
  "ha":8,
  "he":8,
  "hi":8,
  "ho":8,
  "hr":8,
  "ht":8,
  "hu":8,
  "hy":8,
  "hz":8,
  "ia":8,
  "id":8,
  "ie":8,
  "ig":8,
  "ii":8,
  "ik":8,
  "in":8,
  "io":8,
  "is":8,
  "it":8,
  "iu":8,
  "ja":8,
  "jv":8,
  "ka":8,
  "kg":8,
  "ki":8,
  "kj":8,
  "kk":8,
  "kl":8,
  "km":8,
  "kn":8,
  "ko":8,
  "kr":8,
  "ks":8,
  "ku":8,
  "kv":8,
  "kw":8,
  "ky":8,
  "la":8,
  "lb":8,
  "lg":8,
  "li":8,
  "ln":8,
  "lo":8,
  "lt":8,
  "lu":8,
  "lv":8,
  "mg":8,
  "mh":8,
  "mi":8,
  "mk":8,
  "ml":8,
  "mn":8,
  "mr":8,
  "ms":8,
  "mt":8,
  "my":8,
  "na":8,
  "nb":8,
  "nd":8,
  "ne":8,
  "ng":8,
  "nl":8,
  "nn":8,
  "nr":8,
  "nv":8,
  "ny":8,
  "oc":8,
  "of":8,
  "oj":8,
  "om":8,
  "or":8,
  "os":8,
  "pa":8,
  "pi":8,
  "pl":8,
  "ps":8,
  "pt":8,
  "qu":8,
  "rm":8,
  "rn":8,
  "ro":8,
  "ru":8,
  "rw":8,
  "sa":8,
  "sc":8,
  "sd":8,
  "se":8,
  "sg":8,
  "si":8,
  "sk":8,
  "sl":8,
  "sm":8,
  "sn":8,
  "so":8,
  "sq":8,
  "sr":8,
  "ss":8,
  "st":8,
  "su":8,
  "sv":8,
  "sw":8,
  "ta":8,
  "te":8,
  "tg":8,
  "th":8,
  "ti":8,
  "tk":8,
  "tl":8,
  "tn":8,
  "to":8,
  "tr":8,
  "ts":8,
  "tt":8,
  "tw":8,
  "ty":8,
  "ug":8,
  "uk":8,
  "ur":8,
  "uz":8,
  "ve":8,
  "vi":8,
  "vo":8,
  "wa":8,
  "wo":8,
  "xh":8,
  "yi":8,
  "yo":8,
  "za":8,
  "zh":8,
  "zu":8
};

const lowEntropyQueryValues = [
  "https",
  "http",
  "://",
  "%3A%2F%2F",
  "www",
  "url",
  "undefined",
  "impression",
  "session",
  "homepage",
  "client",
  "version",
  "business",
  "title",
  "get",
  "site",
  "name",
  "category",
  "account_id",
  "smartadserver",
  "front",
  "page",
  "view",
  "first",
  "visit",
  "platform",
  "language",
  "automatic",
  "disabled",
  "landing",
  "entertainment",
  "amazon",
  "official",
  "webvisor",
  "anonymous",
  "across",
  "narrative",
  "\":null",
  "\":false",
  "\":\"",
  "\",\"",
  "\",\"",
];

/**
 * Extract cookies from onBeforeSendHeaders
 *
 * @param details Details for onBeforeSendHeaders
 * @returns {*} an array combining all Cookies
 */
function _extractCookies(details) {
  let cookies = [],
    headers = [];

  if (details.requestHeaders) {
    headers = details.requestHeaders;
  } else if (details.responseHeaders) {
    headers = details.responseHeaders;
  }

  for (let i = 0; i < headers.length; i++) {
    let header = headers[i];
    if (header.name.toLowerCase() == "cookie" || header.name.toLowerCase() == "set-cookie") {
      cookies.push(header.value);
    }
  }

  return cookies;
}

/**
 * Check if page is doing cookie tracking. Doing this by estimating the entropy of the cookies
 *
 * @param {Object} details onBeforeSendHeaders details
 * @returns {Boolean} true if it has cookie tracking
 */
function hasCookieTracking(details) {
  let cookies = _extractCookies(details);
  if (!cookies.length) {
    return false;
  }

  let estimatedEntropy = 0;

  // loop over every cookie
  for (let i = 0; i < cookies.length; i++) {
    let cookie = utils.parseCookie(cookies[i], {
      noDecode: true,
      skipAttributes: true,
      skipNonValues: true
    });

    // loop over every name/value pair in every cookie
    for (let name in cookie) {
      if (!utils.hasOwn(cookie, name)) {
        continue;
      }

      // ignore Cloudflare
      // https://support.cloudflare.com/hc/en-us/articles/200170156-Understanding-the-Cloudflare-Cookies
      if (name == "__cf_bm") {
        continue;
      }

      let value = cookie[name].toLowerCase();

      if (!(value in lowEntropyCookieValues)) {
        return true;
      }

      estimatedEntropy += lowEntropyCookieValues[value];
    }
  }

  log(`All cookies for ${details.url} deemed low entropy...`);
  if (estimatedEntropy > constants.MAX_COOKIE_ENTROPY) {
    log(`But total estimated entropy is ${estimatedEntropy} bits, so blocking`);
    return true;
  }

  return false;
}

function startListeners() {
  // inspect cookies in outgoing headers
  let extraInfoSpec = ['requestHeaders'];
  if (utils.hasOwn(chrome.webRequest.OnBeforeSendHeadersOptions, 'EXTRA_HEADERS')) {
    extraInfoSpec.push('extraHeaders');
  }
  chrome.webRequest.onBeforeSendHeaders.addListener(function(details) {
    if (badger.INITIALIZED) {
      badger.heuristicBlocking.checkForTrackingCookies(details);
    }
  }, {urls: ["http://*/*", "https://*/*"]}, extraInfoSpec);

  // inspect cookies in incoming headers
  extraInfoSpec = ['responseHeaders'];
  if (utils.hasOwn(chrome.webRequest.OnResponseStartedOptions, 'EXTRA_HEADERS')) {
    extraInfoSpec.push('extraHeaders');
  }
  chrome.webRequest.onResponseStarted.addListener(function (details) {
    if (!badger.INITIALIZED) {
      return;
    }

    // check for cookie tracking if there are any set-cookie headers
    let has_setcookie_header = false;
    if (details.responseHeaders) {
      for (let i = 0; i < details.responseHeaders.length; i++) {
        if (details.responseHeaders[i].name.toLowerCase() == "set-cookie") {
          has_setcookie_header = true;
          break;
        }
      }
    }
    if (has_setcookie_header) {
      badger.heuristicBlocking.checkForTrackingCookies(details);
    }

    // check for pixel cookie sharing if the response appears to be for an image pixel
    badger.heuristicBlocking.checkForPixelCookieSharing(details);

  }, {urls: ["http://*/*", "https://*/*"]}, extraInfoSpec);
}

export default {
  hasCookieTracking,
  HeuristicBlocker,
  startListeners,
};
