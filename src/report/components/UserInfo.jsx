

export default function UserInfo({ user }){
    return (
        <div className="flex items-center gap-3 ">
            
            <img 
                src={user.profile} 
                alt={user.name}
                className="w-9 h-9 rounded-full object-cover " 
            />
            <div className="min-w-0">
                <p className="text-lg font-semibold text-gray-800 truncate">
                    {user.name}
                </p>
            </div>
            

            
        </div>
    );
}