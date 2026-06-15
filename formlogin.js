const loginForm = document.getElementById("loginForm");
const loginPage = document.getElementById("loginPage");
const dashboardPage = document.getElementById("dashboardPage");
const loginError = document.getElementById("loginError");
const popup = document.getElementById("successPopup");
const continueBtn = document.getElementById("continueBtn");
const logoutBtn = document.getElementById("logoutBtn");
const welcomeText = document.getElementById("welcomeText");

// =========================
// HIDE PAGE
// =========================
function hidePages() {
  document.querySelectorAll("section").forEach((page) => {
    page.style.display = "none";
  });
}

// =========================
// DEFAULT
// =========================
window.addEventListener("load", () => {
  hidePages();
  loginPage.style.display = "flex";
});

// =========================
// LOGIN
// =========================
loginForm.addEventListener("submit", function (e) {
  e.preventDefault();

  const user = document.getElementById("loginRole").value.trim();
  const pass = document.getElementById("loginPassword").value;

  loginError.style.display = "none";

  if (user.toLowerCase() === "user" && pass === "Kar2026") {
    localStorage.setItem("role", user);
    popup.classList.add("show-popup");
    continueBtn.focus();
  } else {
    loginError.textContent = "Invalid access or password";
    loginError.style.display = "block";
  }
});

// =========================
// CONTINUE
// =========================
continueBtn.addEventListener("click", () => {
  popup.classList.remove("show-popup");
  hidePages();
  dashboardPage.style.display = "flex";
  welcomeText.textContent = "Welcome User 👋";
  loginForm.reset();
});

// =========================
// ENTER POPUP
// =========================
document.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && popup.classList.contains("show-popup")) {
    e.preventDefault();
    continueBtn.click();
  }
});

// =========================
// LOGOUT
// =========================
logoutBtn.addEventListener("click", () => {
  localStorage.clear();
  hidePages();
  loginPage.style.display = "flex";
});
