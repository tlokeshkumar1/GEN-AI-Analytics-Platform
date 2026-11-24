#!/usr/bin/env python3
"""
backend/api/calculate_token_usage.py
====================================
Runner & Re-export for calculate_token_usage.
Ensures calculate_token_usage works directly inside backend/api.
"""

from api.utils.calculate_token_usage import main

if __name__ == "__main__":
    main()
