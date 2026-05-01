(() => {
  const links = document.querySelectorAll('a[href]');
  links.forEach((a, idx) => {
    a.style.animation = `rise 360ms ease ${120 + idx * 20}ms both`;
  });
})();
