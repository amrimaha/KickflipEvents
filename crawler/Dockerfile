# ── Stage 1: dependency builder ───────────────────────────────────────────────
FROM python:3.11-slim AS builder

WORKDIR /build

# System packages needed to compile some Python deps (lxml, asyncpg, etc.)
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /app

# Runtime system deps for Playwright Chromium
# playwright install --with-deps pulls these; list them explicitly so the
# layer is cached even if Playwright's bundled list changes.
RUN apt-get update && apt-get install -y --no-install-recommends \
    wget gnupg curl \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
    libgbm1 libasound2 libpangocairo-1.0-0 libgtk-3-0 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

# Copy installed Python packages from builder
COPY --from=builder /install /usr/local

# Install Playwright browser (Chromium only — smaller than full install)
# PLAYWRIGHT_BROWSERS_PATH controls where Chromium is stored inside the image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN playwright install chromium

# Copy application source
COPY . .

# Expose the port used by the FastAPI server (used in server mode only)
EXPOSE 8000

# ── Default command: run-once mode ────────────────────────────────────────────
# The container auto-runs the full crawl and exits when done.
# Override CMD to start the server: ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
CMD ["python", "-m", "app.entrypoint"]
