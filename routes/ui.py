from __future__ import annotations
from flask import Blueprint, render_template
from services.s2 import ensure_backdrop
from config import settings

ui_bp = Blueprint('ui', __name__)

@ui_bp.route('/')
def index():
    return render_template('redirect.html', target='polygon')

@ui_bp.route('/polygon')
def polygon():
    ensure_backdrop()  # ensures backdrop exists (quicklook or placeholder)
    return render_template('polygon.html',
                           classes=settings.CLASS_LIST,
                           brush_size=settings.DEFAULT_BRUSH_SIZE,
                           brush_shape=settings.DEFAULT_BRUSH_SHAPE)

@ui_bp.route('/mask')
def mask():
    ensure_backdrop()
    return render_template('mask.html',
                           classes=settings.CLASS_LIST,
                           brush_size=settings.DEFAULT_BRUSH_SIZE,
                           brush_shape=settings.DEFAULT_BRUSH_SHAPE)