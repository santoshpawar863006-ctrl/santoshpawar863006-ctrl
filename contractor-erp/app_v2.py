import sys
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import *
from db_v2 import init_db, query, execute, scalar, now, DB_PATH

STYLE='''
QMainWindow{background:#f4f7fb} QWidget{font-family:Segoe UI;font-size:13px;color:#182230}
#side{background:#101828} #brand{color:white;font-size:20px;font-weight:800;padding:18px 12px}
QPushButton#nav{color:#d0d5dd;background:transparent;text-align:left;padding:11px 14px;border:0;border-radius:7px}
QPushButton#nav:hover{background:#1d2939} QPushButton#nav:checked{background:#2563eb;color:white;font-weight:700}
QPushButton#primary{background:#2563eb;color:white;border:0;border-radius:7px;padding:9px 14px;font-weight:700}
QPushButton#secondary{background:white;border:1px solid #d0d5dd;border-radius:7px;padding:8px 12px}
QPushButton#danger{background:#b42318;color:white;border:0;border-radius:7px;padding:8px 12px}
QFrame#card{background:white;border:1px solid #e4e7ec;border-radius:10px}
QLabel#title{font-size:24px;font-weight:800} QLabel#section{font-size:16px;font-weight:750} QLabel#muted{color:#667085}
QLabel#kt{color:#667085;font-size:11px} QLabel#kv{font-size:22px;font-weight:800}
QLineEdit,QComboBox,QDoubleSpinBox,QTextEdit{background:white;border:1px solid #d0d5dd;border-radius:7px;padding:7px}
QTableWidget{background:white;border:1px solid #e4e7ec;border-radius:8px;gridline-color:#eef2f6;selection-background-color:#dbeafe}
QHeaderView::section{background:#f8fafc;padding:8px;border:0;border-bottom:1px solid #e4e7ec;font-weight:700}
QTabBar::tab{background:#eef2f7;padding:9px 13px;margin-right:2px} QTabBar::tab:selected{background:#2563eb;color:white}
QProgressBar{background:#eaecf0;border:0;border-radius:5px;height:12px;text-align:center} QProgressBar::chunk{background:#2563eb;border-radius:5px}
'''

def money(v):
    try:return f'₹{float(v):,.0f}'
    except:return '₹0'

class Card(QFrame):
    def __init__(self,t):
        super().__init__();self.setObjectName('card');l=QVBoxLayout(self);l.setContentsMargins(15,13,15,13)
        a=QLabel(t);a.setObjectName('kt');self.v=QLabel('₹0');self.v.setObjectName('kv');l.addWidget(a);l.addWidget(self.v)

class Form(QDialog):
    def __init__(self,title,fields,parent=None):
        super().__init__(parent);self.setWindowTitle(title);self.resize(450,min(650,160+len(fields)*50));self.fields=fields;self.w={};f=QFormLayout(self)
        for k,label,kind,opts in fields:
            if kind=='num':x=QDoubleSpinBox();x.setRange(-1e9,1e9);x.setDecimals(2)
            elif kind=='combo':x=QComboBox();x.addItems(opts)
            elif kind=='memo':x=QTextEdit();x.setFixedHeight(75)
            else:x=QLineEdit()
            self.w[k]=x;f.addRow(label,x)
        b=QDialogButtonBox(QDialogButtonBox.Save|QDialogButtonBox.Cancel);b.accepted.connect(self.accept);b.rejected.connect(self.reject);f.addRow(b)
    def data(self):
        d={}
        for k,x in self.w.items():
            if isinstance(x,QDoubleSpinBox):d[k]=x.value()
            elif isinstance(x,QComboBox):d[k]=x.currentText()
            elif isinstance(x,QTextEdit):d[k]=x.toPlainText().strip()
            else:d[k]=x.text().strip()
        return d

class Projects(QWidget):
    openProject=Signal(int)
    def __init__(self):
        super().__init__();r=QVBoxLayout(self);r.setContentsMargins(24,22,24,24);r.setSpacing(14)
        h=QHBoxLayout();t=QLabel('Projects');t.setObjectName('title');h.addWidget(t);h.addStretch();self.s=QLineEdit();self.s.setPlaceholderText('Search projects...');self.s.setFixedWidth(290);self.s.textChanged.connect(self.refresh);h.addWidget(self.s);a=QPushButton('+ New Project');a.setObjectName('primary');a.clicked.connect(self.add);h.addWidget(a);r.addLayout(h)
        m=QLabel('Open a project to see its complete financial and site position.');m.setObjectName('muted');r.addWidget(m)
        g=QGridLayout();self.cards=[Card('Active Projects'),Card('Total Contract Value'),Card('Client Paid'),Card('Recorded Cost')]
        for i,c in enumerate(self.cards):g.addWidget(c,0,i)
        r.addLayout(g);z=QLabel('All Projects');z.setObjectName('section');r.addWidget(z)
        self.table=QTableWidget(0,8);self.table.setHorizontalHeaderLabels(['Project','Client','Location','Contract Value','Client Paid','Recorded Cost','Progress','Status']);self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch);self.table.setSelectionBehavior(QAbstractItemView.SelectRows);self.table.setEditTriggers(QAbstractItemView.NoEditTriggers);self.table.doubleClicked.connect(self.open_selected);r.addWidget(self.table,1)
        o=QPushButton('Open Selected Project →');o.setObjectName('primary');o.clicked.connect(self.open_selected);r.addWidget(o,alignment=Qt.AlignRight)
    def add(self):
        f=[('name','Project Name','text',None),('client','Client Name','text',None),('location','Site Location','text',None),('value','Contract Value','num',None),('status','Status','combo',['Active','On Hold','Completed','Cancelled']),('progress','Progress %','num',None),('notes','Notes','memo',None)]
        d=Form('New Project',f,self)
        if d.exec()!=QDialog.Accepted:return
        v=d.data()
        if not v['name']:return
        execute('INSERT INTO projects(name,client_name,location,contract_value,status,progress,notes,created_at) VALUES(?,?,?,?,?,?,?,?)',(v['name'],v['client'],v['location'],v['value'],v['status'],v['progress'],v['notes'],now()));self.refresh()
    def open_selected(self,*_):
        row=self.table.currentRow()
        if row>=0:self.openProject.emit(self.table.item(row,0).data(Qt.UserRole))
    def refresh(self):
        term='%'+self.s.text().strip()+'%'
        rows=query('''SELECT p.*,COALESCE((SELECT SUM(received) FROM bills b WHERE b.project_id=p.id),0) paid,
        COALESCE((SELECT SUM(amount) FROM materials m WHERE m.project_id=p.id),0)+COALESCE((SELECT SUM(attendance*daily_wage) FROM labour l WHERE l.project_id=p.id),0)+COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.project_id=p.id),0) cost
        FROM projects p WHERE p.name LIKE ? OR COALESCE(p.client_name,'') LIKE ? OR COALESCE(p.location,'') LIKE ? ORDER BY p.id DESC''',(term,term,term))
        self.cards[0].v.setText(str(sum(1 for x in rows if x['status']=='Active')));self.cards[1].v.setText(money(sum(x['contract_value'] or 0 for x in rows)));self.cards[2].v.setText(money(sum(x['paid'] or 0 for x in rows)));self.cards[3].v.setText(money(sum(x['cost'] or 0 for x in rows)))
        self.table.setRowCount(len(rows))
        for i,x in enumerate(rows):
            vals=[x['name'],x['client_name'] or '',x['location'] or '',money(x['contract_value']),money(x['paid']),money(x['cost']),f"{x['progress'] or 0:.0f}%",x['status']]
            for j,v in enumerate(vals):
                it=QTableWidgetItem(str(v));
                if j==0:it.setData(Qt.UserRole,x['id'])
                self.table.setItem(i,j,it)

class Tx(QWidget):
    changed=Signal()
    def __init__(self,pid,title,table,columns,fields,insert_cols,calc=None):
        super().__init__();self.pid=pid;self.table_name=table;self.cols=columns;self.fields=fields;self.insert_cols=insert_cols;self.calc=calc
        l=QVBoxLayout(self);h=QHBoxLayout();t=QLabel(title);t.setObjectName('section');h.addWidget(t);h.addStretch();a=QPushButton('+ Add');a.setObjectName('primary');a.clicked.connect(self.add);h.addWidget(a);d=QPushButton('Delete');d.setObjectName('danger');d.clicked.connect(self.delete);h.addWidget(d);l.addLayout(h)
        self.table=QTableWidget(0,len(columns));self.table.setHorizontalHeaderLabels([x[0] for x in columns]);self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch);self.table.setSelectionBehavior(QAbstractItemView.SelectRows);self.table.setEditTriggers(QAbstractItemView.NoEditTriggers);l.addWidget(self.table)
    def add(self):
        d=Form('Add '+self.table_name,self.fields,self)
        if d.exec()!=QDialog.Accepted:return
        v=d.data();vals=[self.pid]+[v[k] for k,_,_,_ in self.fields]
        if self.calc:vals=self.calc(vals)
        vals.append(now());marks=','.join('?' for _ in vals);cols='project_id,'+','.join(self.insert_cols)+',created_at';execute(f'INSERT INTO {self.table_name}({cols}) VALUES({marks})',tuple(vals));self.refresh();self.changed.emit()
    def delete(self):
        r=self.table.currentRow()
        if r<0:return
        rid=self.table.item(r,0).data(Qt.UserRole);execute(f'DELETE FROM {self.table_name} WHERE id=?',(rid,));self.refresh();self.changed.emit()
    def refresh(self):
        rows=query(f'SELECT * FROM {self.table_name} WHERE project_id=? ORDER BY id DESC',(self.pid,));self.table.setRowCount(len(rows))
        for i,x in enumerate(rows):
            for j,(label,key,fmt) in enumerate(self.cols):
                v=x[key]
                if fmt=='money':v=money(v)
                elif fmt=='boq':v=money((x['quantity'] or 0)*(x['rate'] or 0))
                elif fmt=='lab':v=money((x['attendance'] or 0)*(x['daily_wage'] or 0))
                it=QTableWidgetItem(str(v if v is not None else ''))
                if j==0:it.setData(Qt.UserRole,x['id'])
                self.table.setItem(i,j,it)

class ProjectDetail(QWidget):
    back=Signal()
    def __init__(self):
        super().__init__();self.pid=None;r=QVBoxLayout(self);r.setContentsMargins(24,18,24,24);h=QHBoxLayout();b=QPushButton('← Projects');b.setObjectName('secondary');b.clicked.connect(self.back.emit);h.addWidget(b);self.name=QLabel('Project');self.name.setObjectName('title');h.addWidget(self.name);h.addStretch();r.addLayout(h);self.meta=QLabel();self.meta.setObjectName('muted');r.addWidget(self.meta);self.progress=QProgressBar();r.addWidget(self.progress)
        self.kgrid=QGridLayout();self.k=[Card('Contract Value'),Card('Client Paid'),Card('Client Outstanding'),Card('Material Cost'),Card('Labour Cost'),Card('Other Expenses'),Card('Total Cost'),Card('Projected Margin')]
        for i,c in enumerate(self.k):self.kgrid.addWidget(c,i//4,i%4)
        r.addLayout(self.kgrid);self.tabs=QTabWidget();r.addWidget(self.tabs,1)
    def load(self,pid):
        self.pid=pid
        while self.tabs.count():self.tabs.removeTab(0)
        self.tables=[]
        def add(name,*a):
            t=Tx(pid,*a);t.changed.connect(self.refresh);self.tables.append(t);self.tabs.addTab(t,name)
        add('BOQ','BOQ / Estimate','boq',[('ID','id',None),('Item','item_code',None),('Description','description',None),('Unit','unit',None),('Qty','quantity',None),('Rate','rate','money'),('Amount','quantity','boq')],[('item_code','Item Code','text',None),('description','Description','text',None),('unit','Unit','text',None),('quantity','Quantity','num',None),('rate','Rate','num',None),('material_rate','Material Rate','num',None),('labour_rate','Labour Rate','num',None)],['item_code','description','unit','quantity','rate','material_rate','labour_rate'])
        def mat(v):
            if not v[7]:v[7]=(v[5] or 0)*(v[6] or 0)
            return v
        add('Materials','Material Purchases','materials',[('ID','id',None),('Date','date',None),('Material','material',None),('Supplier','supplier',None),('Qty','quantity',None),('Rate','rate','money'),('Amount','amount','money')],[('date','Date','text',None),('supplier','Supplier','text',None),('material','Material','text',None),('unit','Unit','text',None),('quantity','Quantity','num',None),('rate','Rate','num',None),('amount','Amount (0=Auto)','num',None),('invoice_no','Invoice No.','text',None),('notes','Notes','memo',None)],['date','supplier','material','unit','quantity','rate','amount','invoice_no','notes'],mat)
        add('Labour','Labour / Wages','labour',[('ID','id',None),('Date','date',None),('Worker','worker_name',None),('Trade','trade',None),('Days','attendance',None),('Daily Wage','daily_wage','money'),('Cost','attendance','lab')],[('date','Date','text',None),('worker_name','Worker / Group','text',None),('trade','Trade','text',None),('attendance','Days','num',None),('daily_wage','Daily Wage','num',None),('advance','Advance','num',None),('paid','Paid','num',None),('notes','Notes','memo',None)],['date','worker_name','trade','attendance','daily_wage','advance','paid','notes'])
        add('Expenses','Other Expenses','expenses',[('ID','id',None),('Date','date',None),('Category','category',None),('Description','description',None),('Amount','amount','money'),('Mode','payment_mode',None)],[('date','Date','text',None),('category','Category','combo',['Transport','Fuel','Machinery','Site','Office','Food','Other']),('description','Description','text',None),('amount','Amount','num',None),('payment_mode','Payment Mode','combo',['Cash','UPI','Bank','Cheque','Other']),('reference','Reference','text',None)],['date','category','description','amount','payment_mode','reference'])
        add('Client Billing','Client Billing / Payments','bills',[('ID','id',None),('Bill No.','bill_no',None),('Date','bill_date',None),('Description','description',None),('Bill','amount','money'),('Received','received','money'),('Status','status',None)],[('bill_no','Bill / RA No.','text',None),('bill_date','Bill Date','text',None),('description','Description','text',None),('amount','Bill Amount','num',None),('received','Amount Received','num',None),('due_date','Due Date','text',None),('status','Status','combo',['Pending','Part Paid','Paid','Overdue'])],['bill_no','bill_date','description','amount','received','due_date','status'])
        add('Purchase Orders','Purchase Orders','purchase_orders',[('ID','id',None),('PO No.','po_no',None),('Date','po_date',None),('Supplier','supplier',None),('Description','description',None),('Amount','amount','money'),('Status','status',None)],[('po_no','PO No.','text',None),('po_date','PO Date','text',None),('supplier','Supplier','text',None),('description','Description','text',None),('amount','PO Amount','num',None),('status','Status','combo',['Open','Approved','Part Received','Closed','Cancelled']),('notes','Notes','memo',None)],['po_no','po_date','supplier','description','amount','status','notes'])
        self.refresh()
    def refresh(self):
        p=query('SELECT * FROM projects WHERE id=?',(self.pid,))[0];self.name.setText(p['name']);self.meta.setText(f"Client: {p['client_name'] or '-'}   •   Site: {p['location'] or '-'}   •   Status: {p['status']}");self.progress.setValue(int(p['progress'] or 0));self.progress.setFormat(f"Work Progress {int(p['progress'] or 0)}%")
        val=float(p['contract_value'] or 0);paid=scalar('SELECT COALESCE(SUM(received),0) FROM bills WHERE project_id=?',(self.pid,));mat=scalar('SELECT COALESCE(SUM(amount),0) FROM materials WHERE project_id=?',(self.pid,));lab=scalar('SELECT COALESCE(SUM(attendance*daily_wage),0) FROM labour WHERE project_id=?',(self.pid,));exp=scalar('SELECT COALESCE(SUM(amount),0) FROM expenses WHERE project_id=?',(self.pid,));cost=mat+lab+exp
        for c,v in zip(self.k,[val,paid,max(val-paid,0),mat,lab,exp,cost,val-cost]):c.v.setText(money(v))
        for t in self.tables:t.refresh()

class SimpleMaster(QWidget):
    def __init__(self,title,table,fields,cols):
        super().__init__();self.tn=table;self.fields=fields;self.cols=cols;l=QVBoxLayout(self);l.setContentsMargins(24,22,24,24);h=QHBoxLayout();t=QLabel(title);t.setObjectName('title');h.addWidget(t);h.addStretch();a=QPushButton('+ Add');a.setObjectName('primary');a.clicked.connect(self.add);h.addWidget(a);l.addLayout(h);self.table=QTableWidget(0,len(cols));self.table.setHorizontalHeaderLabels([c[0] for c in cols]);self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch);l.addWidget(self.table)
    def add(self):
        d=Form('Add',self.fields,self)
        if d.exec()!=QDialog.Accepted:return
        v=d.data();keys=[x[0] for x in self.fields];marks=','.join('?' for _ in range(len(keys)+1));execute(f"INSERT INTO {self.tn}({','.join(keys)},created_at) VALUES({marks})",tuple(v[k] for k in keys)+(now(),));self.refresh()
    def refresh(self):
        rows=query(f'SELECT * FROM {self.tn} ORDER BY id DESC');self.table.setRowCount(len(rows))
        for i,x in enumerate(rows):
            for j,(label,key) in enumerate(self.cols):self.table.setItem(i,j,QTableWidgetItem(str(x[key] or '')))

class Main(QMainWindow):
    def __init__(self):
        super().__init__();self.setWindowTitle('Contractor ERP - Project Control');self.resize(1450,880);c=QWidget();self.setCentralWidget(c);r=QHBoxLayout(c);r.setContentsMargins(0,0,0,0);r.setSpacing(0);side=QFrame();side.setObjectName('side');side.setFixedWidth(220);sl=QVBoxLayout(side);b=QLabel('CONTRACTOR ERP');b.setObjectName('brand');sl.addWidget(b);sub=QLabel('PROJECT COST & CONTROL');sub.setStyleSheet('color:#98a2b3;padding:0 12px 14px');sl.addWidget(sub);self.stack=QStackedWidget();self.nav=[]
        self.projects=Projects();self.projects.openProject.connect(self.open_project);self.add_nav(sl,'Projects',self.projects)
        fields=[('name','Name','text',None),('phone','Phone','text',None),('email','Email','text',None),('address','Address','memo',None),('gstin','GSTIN','text',None),('notes','Notes','memo',None)]
        self.clients=SimpleMaster('Clients','clients',fields,[('Name','name'),('Phone','phone'),('Email','email'),('GSTIN','gstin')]);self.add_nav(sl,'Clients',self.clients)
        self.suppliers=SimpleMaster('Suppliers','suppliers',fields,[('Name','name'),('Phone','phone'),('Email','email'),('GSTIN','gstin')]);self.add_nav(sl,'Suppliers',self.suppliers)
        info=QWidget();il=QVBoxLayout(info);il.setContentsMargins(24,22,24,24);tt=QLabel('Local ERP');tt.setObjectName('title');il.addWidget(tt);q=QLabel('All data is stored locally on this laptop.\n\nDatabase:\n'+str(DB_PATH));q.setStyleSheet('background:white;border:1px solid #e4e7ec;border-radius:9px;padding:18px');il.addWidget(q);il.addStretch();self.add_nav(sl,'Settings / Data',info)
        sl.addStretch();x=QLabel('OFFLINE / LOCAL');x.setStyleSheet('color:#98a2b3;padding:12px');sl.addWidget(x);self.detail=ProjectDetail();self.detail.back.connect(lambda:self.switch(0));self.detail_i=self.stack.addWidget(self.detail);r.addWidget(side);r.addWidget(self.stack,1);self.switch(0)
    def add_nav(self,l,name,page):
        i=self.stack.addWidget(page);b=QPushButton(name);b.setObjectName('nav');b.setCheckable(True);b.clicked.connect(lambda _,n=i:self.switch(n));l.addWidget(b);self.nav.append(b)
    def switch(self,i):
        self.stack.setCurrentIndex(i)
        for n,b in enumerate(self.nav):b.setChecked(n==i)
        w=self.stack.currentWidget()
        if hasattr(w,'refresh'):w.refresh()
    def open_project(self,pid):
        self.detail.load(pid);self.stack.setCurrentIndex(self.detail_i)
        for b in self.nav:b.setChecked(False)

def main():
    init_db();a=QApplication(sys.argv);a.setStyleSheet(STYLE);w=Main();w.show();sys.exit(a.exec())
if __name__=='__main__':main()
