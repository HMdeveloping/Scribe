(function () {
  function repoFromLocation() {
    var hostParts = window.location.hostname.split(".");
    var owner = hostParts[0];
    var repo = window.location.pathname.split("/").filter(Boolean)[0];
    if (!owner || !repo) return null;
    return { owner: owner, repo: repo };
  }

  function setReleaseLinks(repo) {
    var releaseBase = "https://github.com/" + repo.owner + "/" + repo.repo + "/releases";
    var latestBase = releaseBase + "/latest/download/";
    var allReleases = document.getElementById("all-releases");
    if (allReleases) allReleases.href = releaseBase;

    document.querySelectorAll("[data-asset]").forEach(function (link) {
      link.href = latestBase + link.getAttribute("data-asset");
    });
  }

  var repo = repoFromLocation();
  if (repo) {
    setReleaseLinks(repo);
  } else {
    document.querySelectorAll("[data-asset]").forEach(function (link) {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
    });
  }
})();
