# Partzilla Parts Scraper

A simple tool to download ATV and Side-by-Side parts, prices, diagrams, and availability from [Partzilla](https://www.partzilla.com) directly into easy-to-read Excel CSV files.

---

## Prerequisites

Before starting, ensure you have **Node.js** installed on your computer:
- Download and install **Node.js (version 18 or newer)** from [nodejs.org](https://nodejs.org/).
- You can check if it is already installed by opening your terminal or command prompt and typing:
  ```bash
  node -v
  ```

---

## Quick Setup (3 Easy Steps)

Open your terminal or command prompt in this project's folder, then run:

### 1. Install Project Dependencies
```bash
npm install
```

### 2. Install the Required Browser
This downloads the automated browser used to collect parts data:
```bash
npm run install:browsers
```

### 3. Add Your Partzilla Account Login
Partzilla requires an account to show member discounts and MAP prices.

1. Make a copy of the example settings file:
   ```bash
   cp .env.example .env
   ```
   *(On Windows Command Prompt, use `copy .env.example .env`)*

2. Open the new `.env` file in any text editor and fill in your email and password:
   ```ini
   PARTZILLA_EMAIL="your_email@example.com"
   PARTZILLA_PASSWORD="your_password_here"
   ```

---

## How to Run

The scraper collects data for **one brand and one year** at a time.

### Basic Command

```bash
node src/index.js -m <brand> -y <year>
```

### Real Examples (Copy & Paste)

- **Yamaha 2024**:
  ```bash
  node src/index.js -m yamaha -y 2024
  ```

- **Honda 2023**:
  ```bash
  node src/index.js -m honda -y 2023
  ```

- **Polaris 2024**:
  ```bash
  node src/index.js -m polaris -y 2024
  ```

- **Can-Am 2024**:
  ```bash
  node src/index.js -m can-am -y 2024
  ```

- **Kawasaki 2024**:
  ```bash
  node src/index.js -m kawasaki -y 2024
  ```

---

## Helpful Modes & Tricks

### 1. Quick Test Run (Recommended First Time)
To quickly verify that everything works without waiting for a full catalog:
```bash
node src/index.js -m yamaha -y 2024 --test
```
*(This only scrapes 1 model and 1 assembly so you can see the output immediately).*

### 2. Watch the Browser on Screen
By default, the browser runs silently in the background. To watch it open windows and click pages:
```bash
node src/index.js -m yamaha -y 2024 --test --headed
```

### 3. Only Scrape One Vehicle Type
By default, both ATVs and Side-by-Sides are scraped. If you only want one:
- **ATV only**:
  ```bash
  node src/index.js -m honda -y 2023 -c atv
  ```
- **Side-by-Side only**:
  ```bash
  node src/index.js -m polaris -y 2024 -c side-by-side
  ```

### 4. Adjust Scraping Speed (Parallel Workers)
By default, the scraper opens **10 browser tabs in parallel** to extract parts quickly. You can adjust this number using `-p`:

- **Speed it up (faster computer / fast internet)**:
  ```bash
  node src/index.js -m yamaha -y 2024 -p 15
  ```
- **Light on memory (older computer / slower internet)**:
  ```bash
  node src/index.js -m yamaha -y 2024 -p 5
  ```

---

## How to Stop and Resume

- **To Stop**: Press `Ctrl + C` in your terminal. The scraper will safely finish saving its current work and exit.
- **To Resume**: Run the **exact same command** whenever you are ready. The scraper automatically remembers which parts were already downloaded and picks up right where it left off!

---

## Where to Find Your Data

All results are automatically saved in the `output/` folder:

| File | What it contains |
|---|---|
| `output/partzilla_<brand>_<year>.csv` | **Your main spreadsheet**. Open this directly with Microsoft Excel, Google Sheets, or Apple Numbers. |
| `output/partzilla_<brand>_<year>.jsonl` | Complete raw data in JSON format for developers or databases. |
| `output/failures_<brand>_<year>.csv` | Any items that could not be downloaded (e.g. pages with temporary connection errors). |

### Information Included in Your Spreadsheet:
- Brand, Category, Year, Model Name
- Assembly Name and Web Link
- Diagram Blueprint Image Link
- Reference Number on Diagram
- Part Name and SKU / Part Number
- Price, MSRP, and Availability Status (e.g., In Stock, Ships in 2-3 days, or Unavailable)

---

## Retrying Any Missed Items

If your internet dropped during a run, you can retry just the missed assemblies:
```bash
node src/index.js -m yamaha -y 2024 --retry-failures
```

---

## Need Help?

Run this command at any time to see a quick cheat sheet of all available options:
```bash
node src/index.js --help
```
