// CloudFront Function (viewer-request, cloudfront-js-2.0) for the static Next.js export:
// the build emits flat files (login.html, leagues/create.html), but pages link to
// extensionless URLs (/login, /leagues/create). Rewrites the request URI so S3 finds the
// object. Never sees /api/* requests — those match a different cache behavior.
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  // "/" is served by the distribution's defaultRootObject (index.html).
  if (uri === "/") {
    return request;
  }

  // Treat a trailing slash like the extensionless page it names: /players/ -> /players
  if (uri.endsWith("/")) {
    uri = uri.slice(0, -1);
  }

  // A dot in the last segment means a real file (main.css, _next/*.js) — leave untouched.
  var lastSegment = uri.split("/").pop();
  if (!lastSegment.includes(".")) {
    uri = uri + ".html";
  }

  request.uri = uri;
  return request;
}
