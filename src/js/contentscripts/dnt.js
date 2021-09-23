/*
 * This file is part of Privacy Badger <https://privacybadger.org/>
 * Copyright (C) 2018 Electronic Frontier Foundation
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

function getPageScript() {

  // code below is not a content script: no chrome.* APIs /////////////////////

  // return a string
  return "(" + function (NAVIGATOR, NAVIGATOR_INSTANCE, OBJECT) {

    if (NAVIGATOR.doNotTrack != "1") {
      OBJECT.defineProperty(OBJECT.getPrototypeOf(NAVIGATOR), "doNotTrack", {
        get: function doNotTrack() {
          return "1";
        },
        configurable: true,
        enumerable: true
      });
    }

    if (!NAVIGATOR_INSTANCE.globalPrivacyControl) {
      try {
        OBJECT.defineProperty(NAVIGATOR.prototype, "globalPrivacyControl", {
          get: function globalPrivacyControl() {
            return true;
          },
          configurable: true,
          enumerable: true
        });
      } catch (e) {
        console.error("Privacy Badger failed to set navigator.globalPrivacyControl, probably because another extension set it in an incompatible way first.");
      }
    }

  // save locally to keep from getting overwritten by site code
  } + "(self.Navigator, self.navigator, Object));";

  // code above is not a content script: no chrome.* APIs /////////////////////

}

// END FUNCTION DEFINITIONS ///////////////////////////////////////////////////

(function () {

// don't inject into non-HTML documents (such as XML documents)
// but do inject into XHTML documents
if (document instanceof HTMLDocument === false && (
  document instanceof XMLDocument === false ||
  document.createElement('div') instanceof HTMLDivElement === false
)) {
  return;
}

// TODO race condition; fix waiting on https://crbug.com/478183
chrome.runtime.sendMessage({
  type: "checkDNT"
}, function (enabled) {
  if (enabled) {
    window.injectScript(getPageScript());
  }
});

}());
