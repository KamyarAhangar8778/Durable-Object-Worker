{
  "event": "primary_layout_config",
  "payload": {
    "preferences": {
      "theme_mode": "dark",
      "accent_color_3": "#D4AF37",
      "accent_color_4": "#10B981",
      "font_family": "lalezar",
      "animations_enabled": true,
      "header_title": "سامانه مدیریت و گیت‌وی کدهای پاسارگاد",
      "header_position": "top",
      "cuneiform_opacity": 0.12,
      "cuneiform_color": "accent3"
    },
    "layout": {
      "groups_order": ["بخش فرماندهی", "سنسورهای پیرامونی"],
      "groups_cols": 2,
      "group_configs": {
        "بخش فرماندهی": { "maxCols": 3 },
        "سنسورهای پیرامونی": { "maxCols": 4 }
      }
    },
    "segments_definition": [
      {
        "id": "module_1",
        "type": "gpio_toggle",
        "pin": "2",
        "title": "نور تالار آپادانا",
        "group": "بخش فرماندهی",
        "mode": "switch"
      },
      {
        "id": "module_2",
        "type": "gpio_toggle",
        "pin": "13",
        "title": "شاسی زنگ کاخ داریوش",
        "group": "بخش فرماندهی",
        "mode": "push"
      },
      {
        "id": "module_3",
        "type": "gpio_toggle",
        "pin": "4",
        "title": "رله فرمان دروازه ملل",
        "group": "بخش فرماندهی",
        "mode": "switch"
      },
      {
        "id": "module_4",
        "type": "sensor",
        "pin": "A0",
        "title": "دماسنج آذرخش (Atar)",
        "group": "سنسورهای پیرامونی",
        "kind": "temperature"
      }
    ]
  }
}