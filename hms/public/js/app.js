/* Small, dependency-free helpers. No build step, no framework. */
(function () {
  'use strict';

  /* Sidebar on tablets/phones. */
  document.addEventListener('click', function (e) {
    var toggle = e.target.closest('[data-toggle-sidebar]');
    if (toggle) {
      var sidebar = document.getElementById('sidebar');
      if (sidebar) sidebar.classList.toggle('is-collapsed');
    }
  });

  /* Anything destructive asks first. */
  document.addEventListener('submit', function (e) {
    var form = e.target;
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      e.preventDefault();
      return;
    }
    // Stop double submits: a second click must not create a second booking.
    var submitters = form.querySelectorAll('button[type=submit]');
    if (!form.hasAttribute('data-allow-resubmit')) {
      setTimeout(function () {
        submitters.forEach(function (b) { b.disabled = true; });
      }, 0);
      setTimeout(function () {
        submitters.forEach(function (b) { b.disabled = false; });
      }, 6000);
    }
  });

  /* Auto-submit filter bars when a select changes. */
  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.matches('[data-auto-submit]')) {
      var form = el.form;
      if (form) form.submit();
    }
  });

  /* Keep departure after arrival in every date-range form. */
  document.addEventListener('change', function (e) {
    if (!e.target.matches('[data-range-start]')) return;
    var form = e.target.form;
    if (!form) return;
    var end = form.querySelector('[data-range-end]');
    if (end) {
      end.min = e.target.value;
      if (end.value && end.value <= e.target.value) {
        var d = new Date(e.target.value + 'T00:00:00');
        d.setDate(d.getDate() + 1);
        end.value = d.toISOString().slice(0, 10);
      }
      end.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  /* Print helper used by the receipt/KOT windows. */
  window.hmsPrint = function () {
    window.print();
  };
})();
