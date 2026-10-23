# Monk Directory

A searchable directory of the monks of Conception Abbey that works on a phone and a computer.

- **The page** (`index.html`) is a plain website. GitHub Pages hosts it.
- **The data** stays in a Google Sheet ("Monk Directory"). The Master List tab is the single source of truth.
- **A small Google script** (`google-script/Code.gs`) sits inside the Sheet. It reads and saves rows. An optional passcode can lock it.

There is no monk data in this repository. Everything here is public code.

## How the pieces fit

```
Phone or computer  ->  index.html (GitHub Pages)  ->  Google script (passcode optional)  ->  Google Sheet
```

## Set it up (about 15 minutes, on a computer)

### 1. Put the script in the Sheet and publish it
1. Open the Sheet. Choose **Extensions > Apps Script**.
2. Replace the code in `Code.gs` with the contents of `google-script/Code.gs`. Delete any `Index` file left over from an older version.
3. Click the gear (Project Settings). Tick **Show "appsscript.json" manifest file in editor**. Open `appsscript.json` and replace it with `google-script/appsscript.json`.
4. **Optional passcode.** In Project Settings, scroll to **Script properties**, click **Add script property**, set the name to `PASSCODE` and the value to the passcode you choose. Save. If you skip this, the directory is open to anyone who has the link (see Safety notes).
5. Back in the editor, open `Code.gs`, choose the function `checkSheet`, click **Run**, and approve the permission screens. The log should say `Found N monks.` (and whether a passcode is set).
6. Click **Deploy > New deployment**. Click the gear and choose **Web app**. Set **Execute as: Me** and **Who has access: Anyone**. Click **Deploy** and copy the **Web app URL** (it ends in `/exec`).

### 2. Connect the page
Open `config.js` in this repository and paste the Web app URL between the quotes. Save (commit) the change.

### 3. Turn on the website
In this repository, go to **Settings > Pages**. Under **Build and deployment**, choose **Deploy from a branch**, branch **main**, folder **/ (root)**, and save. After a minute the page address appears at the top of that screen.

### 4. Put it on a phone
Open the page address in Safari (enter the passcode once if one is set), then use **Share > Add to Home Screen**.

## Moving it to another account (for example, the priest's)
1. Sign in as the new owner. Open the Sheet and choose **File > Make a copy**.
2. In the copy, repeat step 1 above (the script comes with the copy; add the optional `PASSCODE` property and publish a new web app).
3. Change the Sheet's time zone to Central (**File > Settings**).
4. Put the new Web app URL in `config.js`. To publish under the new owner's GitHub account, fork or copy this repository and repeat step 3.
5. Stop using the old Sheet so there is only one master list.

## Updating
- **The page:** edit `index.html` here. The website updates within a minute or two.
- **The script:** rarely changes. Paste the new `Code.gs` into the Apps Script project, then **Deploy > Manage deployments > pencil > New version > Deploy**. The link does not change.
- **The passcode (optional):** add, change or delete the `PASSCODE` script property. With one set, everyone is asked for it the next time they open the page.

## Safety notes
- **With a passcode:** anyone who has both the web app link and the passcode can read and change the directory. After 10 wrong passcodes, the script refuses all requests for 10 minutes.
- **Without a passcode (open mode):** the web app link is in `config.js` in this public repository, so anyone who finds it can read and change the directory. If that ever happens, use **File > Version history** in the Sheet to restore, and add a `PASSCODE` property to lock it.
- The app never deletes a row. It writes only columns A to K of the Master List. Columns L to P are formulas.
- Edits are recorded in the Sheet's version history (**File > Version history**).
