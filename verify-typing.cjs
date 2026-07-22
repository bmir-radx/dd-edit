// Against the CURRENT source (out/): select a cell by mouse and by keyboard
// navigation, type, and check whether the overlay editor opens each time.
const { _electron } = require('playwright-core')
const electronPath = require('electron')

;(async () => {
  const app = await _electron.launch({ executablePath: electronPath, args: ['out/main/index.js'] })
  try {
    const win = await app.firstWindow({ timeout: 30000 })
    win.on('dialog', (d) => d.accept().catch(() => {}))
    await win.waitForSelector('text=/toolkit \\d/', { timeout: 30000 })
    await win.locator('button', { hasText: 'Reopen' }).click()
    await win.waitForSelector('text=/\\d+ elements/', { timeout: 30000 })
    await win.waitForTimeout(800)

    const canvas = win.locator('canvas').first()
    const box = await canvas.boundingBox()
    const overlay = () =>
      win.evaluate(() => {
        const n = document.querySelector('#portal textarea, #portal input')
        return n ? { value: n.value } : null
      })

    // 1. Click a data cell, then type.
    await win.mouse.click(box.x + 220, box.y + 60)
    await win.waitForTimeout(250)
    await win.keyboard.type('x')
    await win.waitForTimeout(350)
    console.log('type after mouse click:', JSON.stringify(await overlay()))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    // 2. Move selection with arrow keys, then type.
    await win.keyboard.press('ArrowDown')
    await win.waitForTimeout(150)
    await win.keyboard.type('y')
    await win.waitForTimeout(350)
    console.log('type after arrow-key move:', JSON.stringify(await overlay()))
    await win.keyboard.press('Escape')
    await win.waitForTimeout(200)

    // 3. Click into the inspector (focus leaves the grid), click back on the
    //    grid cell once, then type.
    const inspector = win.locator('.inspector input').first()
    if (await inspector.count()) {
      await inspector.click()
      await win.waitForTimeout(150)
    }
    await win.mouse.click(box.x + 220, box.y + 60)
    await win.waitForTimeout(250)
    await win.keyboard.type('z')
    await win.waitForTimeout(350)
    console.log('type after focus round-trip:', JSON.stringify(await overlay()))
    await win.keyboard.press('Escape')
  } finally {
    await app.close()
  }
})().catch((err) => {
  console.error('FAIL:', err.message)
  process.exit(1)
})
