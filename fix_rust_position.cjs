const fs = require('fs');

let mainRs = fs.readFileSync('src-tauri/src/main.rs', 'utf8');

// 1. Inject the PhysicalCoordinate struct mapping to bridge React and the OS window bounds
if (!mainRs.includes('PhysicalPosition')) {
    mainRs = mainRs.replace(
        'use tauri::{',
        'use tauri::{\n    Position, Size, PhysicalPosition, PhysicalSize,'
    );
}

// 2. Remove the auto_resize glitch which forces Webview2 and GTK to disregard given coordinates
mainRs = mainRs.replace(/\.auto_resize\(\)/g, '');

// 3. Map Logical x/y coordinates to strict Physical Window Pixels
mainRs = mainRs.replace(/LogicalPosition::new\(x, y\)/g, 'Position::Physical(PhysicalPosition::new(x as i32, y as i32))');
mainRs = mainRs.replace(/LogicalSize::new\(width, height\)/g, 'Size::Physical(PhysicalSize::new(width as u32, height as u32))');

fs.writeFileSync('src-tauri/src/main.rs', mainRs);
