/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        felt: {
          50: '#e6f2ec',
          300: '#5cb08f',
          500: '#14614a',
          700: '#0d3b2e',
          900: '#082620',
        },
        gold: {
          300: '#f3d489',
          400: '#e8b64c',
          500: '#d9a53a',
          600: '#b8872c',
        },
        cream: '#f5efe0',
      },
    },
  },
  plugins: [],
};
