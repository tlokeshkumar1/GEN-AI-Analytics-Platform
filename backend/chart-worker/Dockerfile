FROM python:3.12-slim
RUN pip install --no-cache-dir "pandas>=2.2,<4" "matplotlib>=3.8,<4" "seaborn>=0.13,<1"
ENV MPLBACKEND=Agg PYTHONDONTWRITEBYTECODE=1
USER 65534:65534
WORKDIR /tmp
