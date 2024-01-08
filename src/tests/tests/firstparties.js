/* eslint-env browser */

let destination = 'https://the.beach/';
let fb_wrap = 'https://facebook.com/l.php?u=' + destination;
let fb_xss = 'https://facebook.com/l.php?u=javascript://bad.site/%250Aalert(1)';

function makeLink(href) {
  let element = document.createElement('a');
  element.href = href;
  element.rel = '';
  return element;
}

function stub(elts, selector) {
  document.querySelectorAllBefore = document.querySelectorAll;
  window.setIntervalBefore = window.setInterval;
  chrome.runtime.sendMessageBefore = chrome.runtime.sendMessage;

  // Stub querySelectorAll so that any selector that includes `selector` will
  // match all the elements in `elts`.
  document.querySelectorAll = function (query) {
    if (query.includes(selector)) {
      return elts;
    } else {
      return document.querySelectorAllBefore(query);
    }
  };

  // Stub runtime.sendMessage so that it returns `true` in response to the
  // `checkEnabled` query.
  chrome.runtime.sendMessage = function (message, callback) {
    if (message.type == "checkEnabled") {
      callback(true);
    } else {
      chrome.runtime.sendMessageBefore(message, callback);
    }
  };
  window.setInterval = function () {};

}

function unstub() {
  document.querySelectorAll = document.querySelectorAllBefore;
  window.setInterval = window.setIntervalBefore;
  chrome.runtime.sendMessage = chrome.runtime.sendMessageBefore;
}

QUnit.module('First parties');

QUnit.test('Facebook script unwraps valid links', (assert) => {
  const NUM_CHECKS = 4,
    done = assert.async();
  assert.expect(NUM_CHECKS);

  let fixture = document.getElementById('qunit-fixture');
  let good_link = makeLink(fb_wrap);
  let bad_link = makeLink(fb_xss);

  // create first-party utility script
  let util_script = document.createElement('script');
  util_script.src = '../js/firstparties/lib/utils.js';

  // create the content script
  let fb_script = document.createElement('script');
  fb_script.src = '../js/firstparties/facebook.js';
  fb_script.onload = function() {
    assert.equal(good_link.href, destination, 'unwrapped good link');
    assert.ok(good_link.rel.includes('noreferrer'),
      'added noreferrer to good link');

    assert.equal(bad_link.href, fb_xss, 'did not unwrap the XSS link');
    assert.notOk(bad_link.rel.includes('noreferrer'),
      'did not change rel of XSS link');

    unstub();
    done();
  };

  // after the utility script has finished loading, add the content script
  util_script.onload = function() {
    fixture.append(fb_script);
  };

  stub([good_link, bad_link], '/l.php?');
  fixture.appendChild(good_link);
  fixture.appendChild(bad_link);
  fixture.appendChild(util_script);
});
