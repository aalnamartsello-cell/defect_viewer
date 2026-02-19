/** @type {import("tailwindcss").Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#070A0E",
          900: "#0A0F16",
          850: "#0E1621",
          800: "#121C29"
        }
      },
      boxShadow: {
        "glow-orange":
          "0 0 0 1px rgba(255,122,24,.15), 0 18px 45px rgba(0,0,0,.65), 0 0 40px rgba(255,122,24,.12)"
      }
    }
  },
  plugins: []
};