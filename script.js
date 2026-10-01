// ===== Theme toggle (remembers choice) =====
const root = document.documentElement;
const themeToggle = document.getElementById("themeToggle");

function applyTheme(theme) {
  root.setAttribute("data-theme", theme);
  themeToggle.textContent = theme === "dark" ? "☀️" : "🌙";
}

let savedTheme = null;
try { savedTheme = localStorage.getItem("theme"); } catch (e) {}
applyTheme(savedTheme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

themeToggle.addEventListener("click", () => {
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
  try { localStorage.setItem("theme", next); } catch (e) {}
});

// ===== Mobile menu =====
const hamburger = document.getElementById("hamburger");
const navLinks = document.getElementById("navLinks");

hamburger.addEventListener("click", () => {
  const open = navLinks.classList.toggle("open");
  hamburger.textContent = open ? "✕" : "☰";
});
navLinks.querySelectorAll("a").forEach((link) =>
  link.addEventListener("click", () => {
    navLinks.classList.remove("open");
    hamburger.textContent = "☰";
  })
);

// ===== Navbar shadow + active link on scroll =====
const navbar = document.getElementById("navbar");
const sections = document.querySelectorAll("main section[id]");
const links = navLinks.querySelectorAll("a");

window.addEventListener("scroll", () => {
  navbar.classList.toggle("scrolled", window.scrollY > 40);

  let current = "home";
  sections.forEach((s) => {
    if (window.scrollY >= s.offsetTop - 140) current = s.id;
  });
  links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + current));
});

// ===== Typing effect =====
const words = ["Web Developer", "App Developer", "GST Consultant", "GeM Expert", "SEO Specialist"];
const typingEl = document.getElementById("typing");
let wordIndex = 0, charIndex = 0, deleting = false;

function type() {
  const word = words[wordIndex];
  typingEl.textContent = word.slice(0, charIndex);

  if (!deleting && charIndex < word.length) charIndex++;
  else if (deleting && charIndex > 0) charIndex--;
  else if (!deleting) { deleting = true; return setTimeout(type, 1400); }
  else { deleting = false; wordIndex = (wordIndex + 1) % words.length; }

  setTimeout(type, deleting ? 50 : 100);
}
type();

// ===== Reveal on scroll, skill bars, counters =====
function animateCounter(el) {
  const target = +el.dataset.target;
  const duration = 1500;
  const start = performance.now();
  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    el.textContent = Math.floor(progress * target);
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      el.classList.add("visible");
      el.querySelectorAll(".fill").forEach((f) => (f.style.width = f.dataset.width + "%"));
      el.querySelectorAll(".counter").forEach(animateCounter);
      observer.unobserve(el);
    });
  },
  { threshold: 0.15 }
);
document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));

// ===== Project filter =====
const filterButtons = document.querySelectorAll(".filter");
const projects = document.querySelectorAll(".project");

filterButtons.forEach((btn) =>
  btn.addEventListener("click", () => {
    filterButtons.forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const f = btn.dataset.filter;
    projects.forEach((p) => p.classList.toggle("hide", f !== "all" && p.dataset.category !== f));
  })
);

// ===== Contact form (opens user's email app) =====
// Change this to your real email address:
const MY_EMAIL = "you@example.com";

document.getElementById("contactForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const data = new FormData(e.target);
  const body = `Name: ${data.get("name")}\nEmail: ${data.get("email")}\n\n${data.get("message")}`;
  window.location.href =
    `mailto:${MY_EMAIL}?subject=${encodeURIComponent(data.get("subject"))}&body=${encodeURIComponent(body)}`;
  document.getElementById("formStatus").textContent = "Thanks! Aapka email app khul raha hai…";
  e.target.reset();
});

// ===== Footer year =====
document.getElementById("year").textContent = new Date().getFullYear();
