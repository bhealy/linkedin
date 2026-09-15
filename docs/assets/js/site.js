(function () {
  const TOTAL_STEPS = 9;
  let currentStep = 1;

  const slides = document.querySelectorAll('.wizard-slide');
  const stepButtons = document.querySelectorAll('.wizard-step-btn');
  const prevBtn = document.getElementById('wizard-prev');
  const nextBtn = document.getElementById('wizard-next');
  const progressFill = document.getElementById('progress-fill');
  const progressLabel = document.getElementById('progress-label');
  const circumference = 2 * Math.PI * 38;

  function setStep(step) {
    currentStep = Math.max(1, Math.min(TOTAL_STEPS, step));

    slides.forEach((slide) => {
      slide.classList.toggle('active', Number(slide.dataset.step) === currentStep);
    });

    stepButtons.forEach((btn) => {
      const btnStep = Number(btn.dataset.step);
      btn.classList.toggle('active', btnStep === currentStep);
      btn.classList.toggle('done', btnStep < currentStep);
    });

    if (progressFill) {
      const offset = circumference - (currentStep / TOTAL_STEPS) * circumference;
      progressFill.style.strokeDasharray = `${circumference}`;
      progressFill.style.strokeDashoffset = String(offset);
    }

    if (progressLabel) {
      progressLabel.textContent = `${currentStep}/${TOTAL_STEPS}`;
    }

    if (prevBtn) {
      prevBtn.disabled = currentStep === 1;
    }

    if (nextBtn) {
      nextBtn.textContent = currentStep === TOTAL_STEPS ? 'Finish' : 'Next step';
    }
  }

  stepButtons.forEach((btn) => {
    btn.addEventListener('click', () => setStep(Number(btn.dataset.step)));
  });

  if (prevBtn) {
    prevBtn.addEventListener('click', () => setStep(currentStep - 1));
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (currentStep === TOTAL_STEPS) {
        document.getElementById('faq')?.scrollIntoView({ behavior: 'smooth' });
        return;
      }
      setStep(currentStep + 1);
    });
  }

  setStep(1);

  document.querySelectorAll('.faq-question').forEach((button) => {
    button.addEventListener('click', () => {
      const item = button.closest('.faq-item');
      const isOpen = item.classList.contains('open');

      document.querySelectorAll('.faq-item.open').forEach((openItem) => {
        if (openItem !== item) {
          openItem.classList.remove('open');
          openItem.querySelector('.faq-question').setAttribute('aria-expanded', 'false');
        }
      });

      item.classList.toggle('open', !isOpen);
      button.setAttribute('aria-expanded', String(!isOpen));
    });
  });

  document.querySelectorAll('.copy-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const code = button.closest('.code-block')?.querySelector('pre')?.textContent;
      if (!code) {
        return;
      }

      try {
        await navigator.clipboard.writeText(code.trim());
        button.textContent = 'Copied!';
        button.classList.add('copied');
        setTimeout(() => {
          button.textContent = 'Copy';
          button.classList.remove('copied');
        }, 2000);
      } catch (err) {
        button.textContent = 'Failed';
        console.error(err.stack || err.message);
      }
    });
  });

  const menuToggle = document.querySelector('.menu-toggle');
  const navLinks = document.querySelector('.nav-links');

  if (menuToggle && navLinks) {
    menuToggle.addEventListener('click', () => {
      navLinks.classList.toggle('open');
      menuToggle.setAttribute(
        'aria-expanded',
        String(navLinks.classList.contains('open'))
      );
    });

    navLinks.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => navLinks.classList.remove('open'));
    });
  }

  document.querySelectorAll('[data-wizard-step]').forEach((el) => {
    el.addEventListener('click', (event) => {
      event.preventDefault();
      const step = Number(el.dataset.wizardStep);
      document.getElementById('wizard')?.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => setStep(step), 300);
    });
  });
})();
