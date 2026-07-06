// ==========================================
// PART 1: DATABASE UPGRADE & NAVIGATION ROUTER
// ==========================================

let db;

// 1. Initialize DB with the new marketPurchases storage layer
const request = indexedDB.open("BusinessManagementDB", 2); // Upgraded version to 2

request.onupgradeneeded = function(e) {
    db = e.target.result;
    if (!db.objectStoreNames.contains("inventory")) {
        db.createObjectStore("inventory", { keyPath: "name" });
    }
    if (!db.objectStoreNames.contains("dailyLogs")) {
        db.createObjectStore("dailyLogs", { keyPath: "date" });
    }
    // New store for tracking the market shopping logs historically
    if (!db.objectStoreNames.contains("marketPurchases")) {
        db.createObjectStore("marketPurchases", { keyPath: "date" });
    }
};

request.onsuccess = function(e) {
    db = e.target.result;
    console.log("Database version 2 connected successfully!");
    updateDatalistCache();
    loadDailyData();
};

// Refresh the searchable datalist dropdown options
function updateDatalistCache() {
    if (!db) return;
    const datalist = document.getElementById("inventory-suggestions");
    datalist.innerHTML = "";

    const tx = db.transaction("inventory", "readonly");
    const store = tx.objectStore("inventory");

    store.openCursor().onsuccess = function(e) {
        const cursor = e.target.result;
        if (cursor) {
            const option = document.createElement("option");
            option.value = cursor.value.name;
            datalist.appendChild(option);
            cursor.continue();
        }
    };
}

// Automatically set both calendar date inputs to today's date
document.getElementById('log-date').valueAsDate = new Date();
document.getElementById('purchase-date').valueAsDate = new Date();

// 2. Three-Way Page Switching Sidebar Router
function switchPage(page) {
    // Reset all menu configurations to clean hidden state
    document.getElementById('page-logs').classList.add('d-none');
    document.getElementById('page-purchases').classList.add('d-none');
    document.getElementById('page-inventory').classList.add('d-none');
    
    document.getElementById('nav-logs').classList.remove('active');
    document.getElementById('nav-purchases').classList.remove('active');
    document.getElementById('nav-inventory').classList.remove('active');

    // Activate the chosen page view selection panel
    if (page === 'logs') {
        document.getElementById('page-logs').classList.remove('d-none');
        document.getElementById('nav-logs').classList.add('active');
        updateDatalistCache();
        loadDailyData();
    } else if (page === 'purchases') {
        document.getElementById('page-purchases').classList.remove('d-none');
        document.getElementById('nav-purchases').classList.add('active');
        loadPurchaseData();
    } else if (page === 'inventory') {
        document.getElementById('page-inventory').classList.remove('d-none');
        document.getElementById('nav-inventory').classList.add('active');
        renderInventory();
    }
}
// ==========================================
// PART 2: BULK MARKET PURCHASES ENGINE
// ==========================================

// 3. Generate Rows for the Market Purchase Interface
function addPurchaseRow(itemName = '', qty = 1, price = 0) {
    const tbody = document.getElementById('purchase-rows');
    const tr = document.createElement('tr');
    
    tr.innerHTML = `
        <td><input type="text" class="form-control p-name" style="text-transform: lowercase;" value="${itemName}" placeholder="Enter product name..." required></td>
        <td><input type="number" class="form-control p-qty" value="${qty}" min="1" oninput="updatePurchaseRowTotal(this)"></td>
        <td><input type="number" class="form-control p-price" value="${price}" min="0" step="0.01" oninput="updatePurchaseRowTotal(this)"></td>
        <td><input type="number" class="form-control p-total" value="${(qty * price).toFixed(2)}" readonly></td>
        <td><button class="btn btn-sm btn-danger" style="width:100%;" onclick="removeRow(this)">Remove</button></td>
    `;
    tbody.appendChild(tr);
}

function updatePurchaseRowTotal(inputElement) {
    const tr = inputElement.closest('tr');
    const qty = parseFloat(tr.querySelector('.p-qty').value) || 0;
    const price = parseFloat(tr.querySelector('.p-price').value) || 0;
    tr.querySelector('.p-total').value = (qty * price).toFixed(2);
}

// 4. Save Purchases, Create New Inventory Products, & Top-Up Stock
async function saveCurrentPurchaseDay() {
    const date = document.getElementById('purchase-date').value;
    if(!date) return alert("Please select a purchase date.");

    // STEP A: Fetch old market purchase to reverse stock top-ups before updating edits
    const txFetch = db.transaction("marketPurchases", "readonly");
    const oldPurchase = await new Promise(resolve => {
        txFetch.objectStore("marketPurchases").get(date).onsuccess = (e) => resolve(e.target.result);
    });

    if (oldPurchase && oldPurchase.items) {
        const txReverse = db.transaction("inventory", "readwrite");
        const invStore = txReverse.objectStore("inventory");
        for (const oldItem of oldPurchase.items) {
            const currentStock = await new Promise(resolve => {
                invStore.get(oldItem.name).onsuccess = (e) => resolve(e.target.result);
            });
            if (currentStock) {
                // Subtract old amount back off to ensure safe recalculation
                let newQty = currentStock.quantity - oldItem.qty;
                if (newQty < 0) newQty = 0; 
                await invStore.put({ name: oldItem.name, quantity: newQty });
            }
        }
    }

    // STEP B: Read active grid rows
    const rows = document.querySelectorAll('#purchase-rows tr');
    const purchaseItems = [];

    rows.forEach(row => {
        const name = row.querySelector('.p-name').value.trim().toLowerCase();
        const qty = parseInt(row.querySelector('.p-qty').value) || 0;
        const price = parseFloat(row.querySelector('.p-price').value) || 0;
        if(name) purchaseItems.push({ name, qty, price });
    });

    // STEP C: Top-up Inventory (Automatically creates new items if they don't exist!)
    const txFinalInv = db.transaction("inventory", "readwrite");
    const finalInvStore = txFinalInv.objectStore("inventory");

    for (const item of purchaseItems) {
        const existingStock = await new Promise(resolve => {
            finalInvStore.get(item.name).onsuccess = (e) => resolve(e.target.result);
        });

        if (existingStock) {
            // Item exists: Add the new batch amount to whatever is already left
            await finalInvStore.put({ name: item.name, quantity: existingStock.quantity + item.qty });
        } else {
            // New Item: Register it directly into storage for the very first time
            await finalInvStore.put({ name: item.name, quantity: item.qty });
        }
    }

    // STEP D: Save the historical market log entry
    const txLogs = db.transaction("marketPurchases", "readwrite");
    txLogs.objectStore("marketPurchases").put({
        date: date,
        items: purchaseItems
    });

    txLogs.oncomplete = function() {
        alert("Market purchases saved and inventory updated successfully!");
        updateDatalistCache();
    };
}

// 5. Load Previous Market Invoices
function loadPurchaseData() {
    if (!db) return;
    const date = document.getElementById('purchase-date').value;
    const tbody = document.getElementById('purchase-rows');
    tbody.innerHTML = '';

    if(!date) return;

    const tx = db.transaction("marketPurchases", "readonly");
    const getReq = tx.objectStore("marketPurchases").get(date);

    getReq.onsuccess = function() {
        const data = getReq.result;
        if(data && data.items) {
            data.items.forEach(item => {
                addPurchaseRow(item.name, item.qty, item.price);
            });
        } else {
            addPurchaseRow();
        }
    };
}
// ==========================================
// PART 3: DAILY SALES LOGS & INVENTORY DISPLAYS
// ==========================================

// 6. Display Active Stock Balances with Action Controls
function renderInventory() {
    const rowsContainer = document.getElementById('inventory-rows');
    rowsContainer.innerHTML = '';
    const tx = db.transaction("inventory", "readonly");
    const store = tx.objectStore("inventory");
    
    store.openCursor().onsuccess = function(e) {
        const cursor = e.target.result;
        if (cursor) {
            const item = cursor.value;
            rowsContainer.innerHTML += `<tr>
                <td style="text-transform: capitalize; font-weight: 600;">${item.name}</td>
                <td><span style="font-weight: bold; color: ${item.quantity <= 5 ? '#dc3545':'#198754'}">${item.quantity} Pcs available</span></td>
                <td style="text-align: center;"><button class="btn btn-sm btn-danger" onclick="deleteStockItem('${item.name}')">Delete</button></td>
            </tr>`;
            cursor.continue();
        }
    };
}

function deleteStockItem(name) {
    if (!confirm(`Are you sure you want to remove "${name}" from stock?`)) return;
    
    const tx = db.transaction("inventory", "readwrite");
    tx.objectStore("inventory").delete(name);
    
    tx.oncomplete = function() {
        updateDatalistCache();
        renderInventory();
    };
}

// 7. Generate Daily Sales Log Rows (Connected to Dropdown suggestions list)
function addSalesRow(itemName = '', qty = 1, price = 0) {
    const tbody = document.getElementById('sales-rows');
    const tr = document.createElement('tr');
    
    tr.innerHTML = `
        <td>
            <input type="text" class="form-control item-name" list="inventory-suggestions" style="text-transform: lowercase;" value="${itemName}" placeholder="Search or type item..." required>
        </td>
        <td><input type="number" class="form-control item-qty" value="${qty}" min="1" oninput="updateRowTotal(this)"></td>
        <td><input type="number" class="form-control item-price" value="${price}" min="0" step="0.01" oninput="updateRowTotal(this)"></td>
        <td><input type="number" class="form-control item-total" value="${(qty * price).toFixed(2)}" readonly></td>
        <td><button class="btn btn-sm btn-danger" style="width:100%;" onclick="removeRow(this)">Remove</button></td>
    `;
    tbody.appendChild(tr);
    calculateGrandTotals();
}

function removeRow(button) {
    button.closest('tr').remove();
    calculateGrandTotals();
}

function updateRowTotal(inputElement) {
    const tr = inputElement.closest('tr');
    const qty = parseFloat(tr.querySelector('.item-qty').value) || 0;
    const price = parseFloat(tr.querySelector('.item-price').value) || 0;
    tr.querySelector('.item-total').value = (qty * price).toFixed(2);
    calculateGrandTotals();
}

function calculateGrandTotals() {
    let totalSales = 0;
    document.querySelectorAll('.item-total').forEach(input => {
        totalSales += parseFloat(input.value) || 0;
    });
    const expense = parseFloat(document.getElementById('expense-amount').value) || 0;
    const netProfit = totalSales - expense;

    document.getElementById('total-sales-display').innerText = totalSales.toFixed(2);
    document.getElementById('total-expenses-display').innerText = expense.toFixed(2);
    document.getElementById('net-profit-display').innerText = netProfit.toFixed(2);
}

// 8. Save Sales Logs & Subtract Items from Warehouse balances
// 12. Overhauled Save Engine: Stores Multi-Row Sales & Expenses Array Snapshots
async function saveCurrentDay() {
    const date = document.getElementById('log-date').value;
    if(!date) return alert("Please select a date first.");

    // STEP A: Fetch previous logs to reverse deductions before applying updates
    const txFetch = db.transaction("dailyLogs", "readonly");
    const oldRecord = await new Promise(resolve => {
        txFetch.objectStore("dailyLogs").get(date).onsuccess = (e) => resolve(e.target.result);
    });

    if (oldRecord && oldRecord.sales) {
        const txReverse = db.transaction("inventory", "readwrite");
        const invStore = txReverse.objectStore("inventory");
        for (const oldSale of oldRecord.sales) {
            const currentStock = await new Promise(resolve => {
                invStore.get(oldSale.name).onsuccess = (e) => resolve(e.target.result);
            });
            if (currentStock) {
                await invStore.put({ name: oldSale.name, quantity: currentStock.quantity + oldSale.qty });
            }
        }
    }

    // STEP B: Parse modern interface sales row data states
    const salesRows = document.querySelectorAll('#sales-rows tr');
    const salesData = [];
    salesRows.forEach(row => {
        const name = row.querySelector('.item-name').value.trim().toLowerCase();
        const qty = parseInt(row.querySelector('.item-qty').value) || 0;
        const price = parseFloat(row.querySelector('.item-price').value) || 0;
        if(name) salesData.push({ name, qty, price });
    });

    // STEP C: Parse multi-row expenditures cleanly
    const expenseRows = document.querySelectorAll('#expense-rows tr');
    const expensesData = [];
    expenseRows.forEach(row => {
        const desc = row.querySelector('.exp-desc').value.trim();
        const amount = parseFloat(row.querySelector('.exp-amount').value) || 0;
        if(desc || amount > 0) expensesData.push({ desc, amount });
    });

    // STEP D: Deduct sales quantities ONLY if item is tracked in inventory
    const txFinalInv = db.transaction("inventory", "readwrite");
    const finalInvStore = txFinalInv.objectStore("inventory");

    for (const sale of salesData) {
        const itemInStock = await new Promise(resolve => {
            finalInvStore.get(sale.name).onsuccess = (e) => resolve(e.target.result);
        });
        if (itemInStock) {
            await finalInvStore.put({ name: sale.name, quantity: itemInStock.quantity - sale.qty });
        }
    }

    // STEP E: Save unified multi-array database record entries
    const txLogs = db.transaction("dailyLogs", "readwrite");
    txLogs.objectStore("dailyLogs").put({
        date: date,
        sales: salesData,
        expenses: expensesData // New multi-expense tracker inclusion element
    });

    txLogs.oncomplete = function() {
        alert("Day records successfully saved offline!");
        updateDatalistCache();
        calculateGrandTotals();
    };
}

// 13. Overhauled Load Engine: Restores All Sales Rows & All Expense Rows Safely
function loadDailyData() {
    if (!db) return;
    const date = document.getElementById('log-date').value;
    const salesTbody = document.getElementById('sales-rows');
    const expenseTbody = document.getElementById('expense-rows');
    
    salesTbody.innerHTML = ''; 
    expenseTbody.innerHTML = ''; 

    if(!date) return;

    const tx = db.transaction("dailyLogs", "readonly");
    const getReq = tx.objectStore("dailyLogs").get(date);

    getReq.onsuccess = function() {
        const data = getReq.result;
        if(data) {
            // Restore saved sales history rows
            if(data.sales && data.sales.length > 0) {
                data.sales.forEach(sale => addSalesRow(sale.name, sale.qty, sale.price));
            } else {
                addSalesRow();
            }

            // Restore saved dynamic expense list rows
            if(data.expenses && data.expenses.length > 0) {
                data.expenses.forEach(exp => addExpenseRow(exp.desc, exp.amount));
            } else {
                addExpenseRow();
            }
        } else {
            // Setup fresh entry boards for newly opened days
            addSalesRow(); 
            addExpenseRow();
        }
        calculateGrandTotals();
    };
}

// ==========================================
// PART 4: MULTI-ROW DYNAMIC EXPENSES ENGINE
// ==========================================

// 10. Generate Dynamic Expense Rows
function addExpenseRow(description = '', amount = 0) {
    const tbody = document.getElementById('expense-rows');
    const tr = document.createElement('tr');
    
    tr.innerHTML = `
        <td><input type="text" class="form-control exp-desc" value="${description}" placeholder="e.g. Transport, Fuel, Feeding" required></td>
        <td><input type="number" class="form-control exp-amount" value="${amount}" min="0" step="0.01" oninput="calculateGrandTotals()" required></td>
        <td><button class="btn btn-sm btn-danger" style="width:100%;" onclick="removeRow(this)">X</button></td>
    `;
    tbody.appendChild(tr);
    calculateGrandTotals();
}

// 11. Overhauled Calculation Engine for Multi-Row Math
function calculateGrandTotals() {
    let totalSales = 0;
    document.querySelectorAll('.item-total').forEach(input => {
        totalSales += parseFloat(input.value) || 0;
    });

    // Loop through and sum up every single expense line on the screen
    let totalExpenses = 0;
    document.querySelectorAll('.exp-amount').forEach(input => {
        totalExpenses += parseFloat(input.value) || 0;
    });

    const netProfit = totalSales - totalExpenses;

    document.getElementById('total-sales-display').innerText = totalSales.toFixed(2);
    document.getElementById('total-expenses-display').innerText = totalExpenses.toFixed(2);
    document.getElementById('net-profit-display').innerText = netProfit.toFixed(2);
}
