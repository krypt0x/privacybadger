/* globals URL_REGEX:false, findInAllFrames:false, observeMutations:false */
// Adapted from https://github.com/mgziminsky/FacebookTrackingRemoval
(function() {
let fb_wrapped_link = "a[href*='facebook.com/l.php?'";

// remove all attributes from a link except for class and ARIA attributes
function cleanAttrs(elem) {
  for (let i = elem.attributes.length - 1; i >= 0; --i) {
    const attr = elem.attributes[i];
    if (attr.name !== 'class' && !attr.name.startsWith('aria-')) {
      elem.removeAttribute(attr.name);
    }
  }
}

// Remove excessive attributes and event listeners from link a and replace
// its destination with href
function cleanLink(a) {
  let href = new URL(a.href).searchParams.get('u');

  if (!href || !href.match(URL_REGEX)) {
    // If we can't extract a good URL, abort without breaking the links
    return;
  }

  cleanAttrs(a);
  a.href = href;
  a.rel = "noreferrer";
  a.target = "_blank";
  a.addEventListener("click", function (e) { e.stopPropagation(); }, true);
  a.addEventListener("mousedown", function (e) { e.stopPropagation(); }, true);
  a.addEventListener("mouseup", function (e) { e.stopPropagation(); }, true);
  a.addEventListener("mouseover", function (e) { e.stopPropagation(); }, true);
}

// unwrap wrapped links in the original page
findInAllFrames(fb_wrapped_link).forEach((link) => {
  cleanLink(link);
});

// Execute redirect unwrapping each time new content is added to the page
observeMutations(fb_wrapped_link, cleanLink);
}());
